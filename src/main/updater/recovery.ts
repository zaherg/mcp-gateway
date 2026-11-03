import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MAX_RECOVERY_TREE_BYTES, MAX_UPDATE_TREE_FILES, treeUsage } from "./budget";
import {
  isSafeRelativeComponent,
  UPDATER_HASH_PATTERN,
  UPDATER_IDENTIFIER,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";
import {
  atomicWritePrivateJsonSync,
  ensurePrivateDirectory,
  readPrivateJson,
  UpdaterStateError,
} from "./storage";
import type { ApplicationVerifier, BundleMetadata, PublisherIdentity } from "./verify";

const RECORD_FIELDS = [
  "created_at",
  "hash",
  "identifier",
  "manual_only",
  "retained_bundle_path",
  "schema_version",
  "version",
];

export interface RecoveryRecord {
  schema_version: 1;
  identifier: string;
  version: string;
  hash: string;
  retained_bundle_path: string;
  created_at: string;
  manual_only: true;
}

export interface RetainPreviousOptions {
  appBundlePath: string;
  dataDirectory: string;
  publisher: PublisherIdentity;
  version: string;
  hash: string;
  verifier: ApplicationVerifier;
  signal?: AbortSignal;
}

function recoveryRoot(dataDirectory: string): string {
  return join(dataDirectory, "updates/recovery");
}

function recoveryRecordPath(dataDirectory: string): string {
  return join(recoveryRoot(dataDirectory), "latest.json");
}

function parseRecovery(document: unknown, dataDirectory: string): RecoveryRecord {
  if (typeof document !== "object" || document === null || Array.isArray(document))
    throw new UpdaterStateError("recoveryRecord");
  const record = document as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== RECORD_FIELDS.length ||
    !RECORD_FIELDS.every((key, index) => keys[index] === key)
  )
    throw new UpdaterStateError("recoveryRecord");
  if (record.schema_version !== 1 || record.manual_only !== true)
    throw new UpdaterStateError("recoveryRecord");
  const text = (key: string) => {
    const value = record[key];
    if (typeof value !== "string") throw new UpdaterStateError("recoveryRecord");
    return value;
  };
  const value: RecoveryRecord = {
    schema_version: 1,
    identifier: text("identifier"),
    version: text("version"),
    hash: text("hash"),
    retained_bundle_path: text("retained_bundle_path"),
    created_at: text("created_at"),
    manual_only: true,
  };
  const root = recoveryRoot(dataDirectory);
  if (
    value.identifier !== UPDATER_IDENTIFIER ||
    !UPDATER_STABLE_VERSION_PATTERN.test(value.version) ||
    !UPDATER_HASH_PATTERN.test(value.hash) ||
    !value.retained_bundle_path.endsWith(".app") ||
    value.retained_bundle_path !== resolve(value.retained_bundle_path) ||
    !value.retained_bundle_path.startsWith(`${resolve(root)}/`) ||
    !isSafeRelativeComponent(value.retained_bundle_path.slice(root.length + 1))
  )
    throw new UpdaterStateError("recoveryRecord");
  return value;
}

async function copyBundleBounded(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  let files = 0;
  let bytes = 0;
  const visit = async (current: string, target: string): Promise<void> => {
    if (signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new UpdaterStateError("recoveryBundle");
    if (info.isDirectory()) {
      await mkdir(target, { recursive: false, mode: info.mode & 0o700 });
      for (const name of await readdir(current))
        await visit(join(current, name), join(target, name));
      return;
    }
    if (!info.isFile()) throw new UpdaterStateError("recoveryBundle");
    files++;
    bytes += info.size;
    if (files > MAX_UPDATE_TREE_FILES || bytes > MAX_RECOVERY_TREE_BYTES)
      throw new UpdaterStateError("storageBudget");
    if (signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
    await copyFile(current, target);
    await chmod(target, info.mode & 0o777);
    if (signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
  };
  await visit(source, destination);
}

async function verifyCopiedBundle(
  options: RetainPreviousOptions,
  path: string,
): Promise<BundleMetadata> {
  const metadata = await options.verifier.verifyRetained(
    path,
    {
      publisher: options.publisher,
      version: options.version,
      hash: options.hash,
    },
    options.signal,
  );
  const launcher = await lstat(join(path, "Contents/MacOS", metadata.executable));
  if (launcher.isSymbolicLink() || !launcher.isFile())
    throw new UpdaterStateError("recoveryBundle");
  return metadata;
}

export async function retainPreviousApplication(
  options: RetainPreviousOptions,
): Promise<RecoveryRecord> {
  const root = recoveryRoot(options.dataDirectory);
  await ensurePrivateDirectory(root);
  const current = await options.verifier.verifyCandidate(
    options.appBundlePath,
    {
      publisher: options.publisher,
      version: options.version,
      hash: options.hash,
    },
    options.signal,
  );
  if (options.signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
  if (current.version !== options.version || current.hash !== options.hash)
    throw new UpdaterStateError("recoveryIdentity");
  const suffix = `${options.version}-${options.hash}-${randomBytes(8).toString("hex")}`;
  const temporary = join(root, `.${suffix}.partial.app`);
  const retained = join(root, `previous-${suffix}.app`);
  let retainedPublished = false;
  let recordPublished = false;
  try {
    await copyBundleBounded(options.appBundlePath, temporary, options.signal);
    await verifyCopiedBundle(options, temporary);
    if (options.signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
    await treeUsage(temporary, {
      maxBytes: MAX_RECOVERY_TREE_BYTES,
      maxFiles: MAX_UPDATE_TREE_FILES,
      maxEntries: MAX_UPDATE_TREE_FILES,
      ...(options.signal ? { signal: options.signal } : {}),
      label: "recovery-staging",
    });
    await rename(temporary, retained);
    retainedPublished = true;
    await verifyCopiedBundle(options, retained);
    if (options.signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
    const record: RecoveryRecord = {
      schema_version: 1,
      identifier: UPDATER_IDENTIFIER,
      version: options.version,
      hash: options.hash,
      retained_bundle_path: retained,
      created_at: new Date().toISOString(),
      manual_only: true,
    };
    const previous = await readPrivateJson(recoveryRecordPath(options.dataDirectory))
      .then((value) => parseRecovery(value, options.dataDirectory))
      .catch(() => undefined);
    if (options.signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
    if (options.signal?.aborted) throw new UpdaterStateError("recoveryCancelled");
    atomicWritePrivateJsonSync(recoveryRecordPath(options.dataDirectory), record);
    recordPublished = true;
    if (
      previous &&
      previous.retained_bundle_path !== retained &&
      previous.retained_bundle_path.startsWith(`${resolve(root)}/`)
    )
      await rm(previous.retained_bundle_path, { recursive: true, force: true }).catch(
        () => undefined,
      );
    return record;
  } catch (error) {
    if (retainedPublished && !recordPublished) await rm(retained, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRetainedRecovery(options: {
  dataDirectory: string;
  publisher: PublisherIdentity;
  verifier: ApplicationVerifier;
}): Promise<{ record: RecoveryRecord; metadata: BundleMetadata }> {
  const record = parseRecovery(
    await readPrivateJson(recoveryRecordPath(options.dataDirectory)),
    options.dataDirectory,
  );
  const info = await lstat(record.retained_bundle_path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new UpdaterStateError("recoveryBundle");
  const metadata = await options.verifier.verifyRetained(record.retained_bundle_path, {
    publisher: options.publisher,
    version: record.version,
    hash: record.hash,
  });
  return { record, metadata };
}

export async function retainedRecoveryEntries(dataDirectory: string): Promise<string[]> {
  const root = recoveryRoot(dataDirectory);
  const names = await readdir(root).catch(() => []);
  return names.filter((name) => name.endsWith(".app"));
}

export function manualRecoveryDescription(record: RecoveryRecord): string {
  return `A verified copy of version ${record.version} is retained at ${record.retained_bundle_path}. It is a manual recovery copy, not an automatic downgrade.`;
}
