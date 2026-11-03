import { createHash, randomBytes } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectUpdateArchive, type UpdateArchiveLimits } from "./archive";
import {
  isSafeRelativeComponent,
  MAX_EXPANDED_ARCHIVE_BYTES,
  PREPARED_UPDATE_FILE,
  UPDATER_ARCH,
  UPDATER_ARTIFACT_FILE,
  UPDATER_CHANNEL,
  UPDATER_HASH_PATTERN,
  UPDATER_IDENTIFIER,
  UPDATER_PLATFORM,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";
import { assertUpdateStoragePaths } from "./process";
import {
  atomicWritePrivateJsonSync,
  readPrivateJson,
  removePrivateFile,
  UpdaterStateError,
} from "./storage";

const PREPARED_FIELDS = [
  "arch",
  "artifact_file",
  "channel",
  "hash",
  "identifier",
  "platform",
  "retained_tar_path",
  "schema_version",
  "version",
];

export interface PreparedUpdateRecord {
  schema_version: 1;
  identifier: string;
  channel: string;
  version: string;
  hash: string;
  platform: string;
  arch: string;
  retained_tar_path: string;
  artifact_file: string;
}

export interface SelectedUpdate {
  version: string;
  hash: string;
}

export interface FrozenCandidate {
  schema_version: 1;
  identifier: string;
  channel: string;
  version: string;
  hash: string;
  artifact_file: string;
  prepared_path: string;
  prepared_sha256: string;
  retained_tar_path: string;
  archive_sha256: string;
  archive_bytes: number;
  frozen_at: string;
}

export function isHigherStableVersion(current: string, candidate: string): boolean {
  if (
    !UPDATER_STABLE_VERSION_PATTERN.test(current) ||
    !UPDATER_STABLE_VERSION_PATTERN.test(candidate)
  )
    return false;
  try {
    return Bun.semver.order(candidate, current) === 1;
  } catch {
    return false;
  }
}

function preparedPath(channelRoot: string): string {
  return join(channelRoot, "self-extraction", PREPARED_UPDATE_FILE);
}

function retainedPath(channelRoot: string, hash: string): string {
  return resolve(join(channelRoot, "self-extraction", `${hash}.tar`));
}

function hasExactFields(document: Record<string, unknown>): boolean {
  const keys = Object.keys(document).sort();
  return (
    keys.length === PREPARED_FIELDS.length &&
    PREPARED_FIELDS.every((field, index) => keys[index] === field)
  );
}

function requireString(document: Record<string, unknown>, key: string): string {
  const value = document[key];
  if (typeof value !== "string") throw new UpdaterStateError("preparedDocument");
  return value;
}

function parsePrepared(document: unknown, channelRoot: string): PreparedUpdateRecord {
  if (typeof document !== "object" || document === null || Array.isArray(document))
    throw new UpdaterStateError("preparedDocument");
  const record = document as Record<string, unknown>;
  if (!hasExactFields(record) || record.schema_version !== 1)
    throw new UpdaterStateError("preparedDocument");
  const identifier = requireString(record, "identifier");
  const channel = requireString(record, "channel");
  const version = requireString(record, "version");
  const hash = requireString(record, "hash");
  const platform = requireString(record, "platform");
  const arch = requireString(record, "arch");
  const retained = requireString(record, "retained_tar_path");
  const artifact = requireString(record, "artifact_file");
  if (
    identifier !== UPDATER_IDENTIFIER ||
    channel !== UPDATER_CHANNEL ||
    platform !== UPDATER_PLATFORM ||
    arch !== UPDATER_ARCH ||
    !UPDATER_STABLE_VERSION_PATTERN.test(version) ||
    !UPDATER_HASH_PATTERN.test(hash) ||
    artifact !== UPDATER_ARTIFACT_FILE ||
    !isSafeRelativeComponent(artifact) ||
    retained !== resolve(retained) ||
    retained !== retainedPath(channelRoot, hash)
  )
    throw new UpdaterStateError("preparedDocument");
  return {
    schema_version: 1,
    identifier,
    channel,
    version,
    hash,
    platform,
    arch,
    retained_tar_path: retained,
    artifact_file: artifact,
  };
}

async function assertManagedFile(
  path: string,
  maximumBytes: number | undefined,
  ownerOnly: boolean,
): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new UpdaterStateError("preparedArchive");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new UpdaterStateError("preparedArchive");
  if ((info.mode & (ownerOnly ? 0o077 : 0o022)) !== 0)
    throw new UpdaterStateError("preparedPermissions");
  if (info.size <= 0 || (maximumBytes !== undefined && info.size > maximumBytes))
    throw new UpdaterStateError("preparedArchive");
}

export async function readPreparedUpdate(channelRoot: string): Promise<PreparedUpdateRecord> {
  await assertManagedFile(preparedPath(channelRoot), 64 * 1024, true);
  const document = await readPrivateJson(preparedPath(channelRoot));
  const record = parsePrepared(document, channelRoot);
  await assertManagedFile(record.retained_tar_path, undefined, false);
  return record;
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw new UpdaterStateError("cancelled");
    hash.update(chunk);
  }
  if (signal?.aborted) throw new UpdaterStateError("cancelled");
  return hash.digest("hex");
}

async function copyStableArchive(
  source: string,
  destination: string,
  maximumBytes: number = MAX_EXPANDED_ARCHIVE_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new UpdaterStateError("cancelled");
  const before = await lstat(source);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0 || before.size > maximumBytes)
    throw new UpdaterStateError("preparedArchive");
  if (typeof process.getuid === "function" && before.uid !== process.getuid())
    throw new UpdaterStateError("preparedArchive");
  if ((before.mode & 0o022) !== 0) throw new UpdaterStateError("preparedPermissions");
  const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let total = 0;
  try {
    destinationHandle = await open(destination, "wx", 0o600);
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      if (signal?.aborted) throw new UpdaterStateError("cancelled");
      const result = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > maximumBytes) throw new UpdaterStateError("preparedArchiveTooLarge");
      hash.update(buffer.subarray(0, result.bytesRead));
      let written = 0;
      while (written < result.bytesRead) {
        const output = await destinationHandle.write(buffer, written, result.bytesRead - written);
        if (output.bytesWritten <= 0) throw new UpdaterStateError("preparedArchive");
        written += output.bytesWritten;
      }
    }
    await destinationHandle.sync();
    if (signal?.aborted) throw new UpdaterStateError("cancelled");
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
  const after = await lstat(source);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    total !== before.size
  ) {
    await rm(destination, { force: true });
    throw new UpdaterStateError("preparedArchiveChanged");
  }
  return hash.digest("hex");
}

export interface FreezeOptions {
  channelRoot: string;
  dataDirectory: string;
  selected: SelectedUpdate;
  limits?: UpdateArchiveLimits;
  signal?: AbortSignal;
}

export async function freezePreparedCandidate(options: FreezeOptions): Promise<{
  candidate: FrozenCandidate;
  admission: Awaited<ReturnType<typeof inspectUpdateArchive>>;
}> {
  const { channelRoot, dataDirectory, selected, limits, signal } = options;
  if (signal?.aborted) throw new UpdaterStateError("cancelled");
  const prepared = await readPreparedUpdate(channelRoot);
  if (prepared.version !== selected.version || prepared.hash !== selected.hash)
    throw new UpdaterStateError("preparedSelection");
  const stagedPath = join(
    channelRoot,
    "self-extraction",
    `.${prepared.hash}.${randomBytes(16).toString("hex")}.frozen`,
  );
  try {
    const copiedSha = await copyStableArchive(
      prepared.retained_tar_path,
      stagedPath,
      limits?.maxArchiveBytes ?? MAX_EXPANDED_ARCHIVE_BYTES,
      signal,
    );
    const admission = await inspectUpdateArchive(stagedPath, limits, signal);
    if (signal?.aborted) throw new UpdaterStateError("cancelled");
    if (admission.sha256 !== copiedSha) throw new UpdaterStateError("preparedArchiveChanged");
    await rename(stagedPath, prepared.retained_tar_path);
    const published = await lstat(prepared.retained_tar_path);
    if (published.isSymbolicLink() || !published.isFile() || published.size !== admission.bytes)
      throw new UpdaterStateError("preparedArchiveChanged");
    if (signal?.aborted) throw new UpdaterStateError("cancelled");
    admission.path = prepared.retained_tar_path;
    const preparedSha = await hashFile(preparedPath(channelRoot), signal);
    if (signal?.aborted) throw new UpdaterStateError("cancelled");
    const candidate: FrozenCandidate = {
      schema_version: 1,
      identifier: prepared.identifier,
      channel: prepared.channel,
      version: prepared.version,
      hash: prepared.hash,
      artifact_file: prepared.artifact_file,
      prepared_path: preparedPath(channelRoot),
      prepared_sha256: preparedSha,
      retained_tar_path: prepared.retained_tar_path,
      archive_sha256: admission.sha256,
      archive_bytes: admission.bytes,
      frozen_at: new Date().toISOString(),
    };
    const recordPath = candidateRecordPath(dataDirectory, prepared.hash);
    if (signal?.aborted) throw new UpdaterStateError("cancelled");
    atomicWritePrivateJsonSync(recordPath, candidate);
    return { candidate, admission };
  } finally {
    await rm(stagedPath, { force: true });
  }
}

export function candidateRecordPath(dataDirectory: string, hash: string): string {
  if (!UPDATER_HASH_PATTERN.test(hash)) throw new UpdaterStateError("preparedHash");
  return join(dataDirectory, "updates/candidates", `${hash}.json`);
}

function parseFrozen(document: unknown): FrozenCandidate {
  if (typeof document !== "object" || document === null || Array.isArray(document))
    throw new UpdaterStateError("candidateRecord");
  const record = document as Record<string, unknown>;
  const required = [
    "archive_bytes",
    "archive_sha256",
    "artifact_file",
    "channel",
    "frozen_at",
    "hash",
    "identifier",
    "prepared_path",
    "prepared_sha256",
    "retained_tar_path",
    "schema_version",
    "version",
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== required.length || !required.every((key, index) => keys[index] === key))
    throw new UpdaterStateError("candidateRecord");
  if (record.schema_version !== 1) throw new UpdaterStateError("candidateRecord");
  const text = (key: string) => {
    const value = record[key];
    if (typeof value !== "string") throw new UpdaterStateError("candidateRecord");
    return value;
  };
  const bytes = record.archive_bytes;
  if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0)
    throw new UpdaterStateError("candidateRecord");
  const candidate: FrozenCandidate = {
    schema_version: 1,
    identifier: text("identifier"),
    channel: text("channel"),
    version: text("version"),
    hash: text("hash"),
    artifact_file: text("artifact_file"),
    prepared_path: text("prepared_path"),
    prepared_sha256: text("prepared_sha256"),
    retained_tar_path: text("retained_tar_path"),
    archive_sha256: text("archive_sha256"),
    archive_bytes: bytes as number,
    frozen_at: text("frozen_at"),
  };
  if (
    candidate.identifier !== UPDATER_IDENTIFIER ||
    candidate.channel !== UPDATER_CHANNEL ||
    !UPDATER_STABLE_VERSION_PATTERN.test(candidate.version) ||
    !UPDATER_HASH_PATTERN.test(candidate.hash) ||
    !/^[a-f0-9]{64}$/.test(candidate.archive_sha256) ||
    !/^[a-f0-9]{64}$/.test(candidate.prepared_sha256)
  )
    throw new UpdaterStateError("candidateRecord");
  return candidate;
}

export async function readFrozenCandidate(
  dataDirectory: string,
  hash: string,
): Promise<FrozenCandidate> {
  return parseFrozen(await readPrivateJson(candidateRecordPath(dataDirectory, hash)));
}

export async function revalidateFrozenCandidate(
  channelRoot: string,
  dataDirectory: string,
  selected: SelectedUpdate,
  expected?: FrozenCandidate,
  signal?: AbortSignal,
): Promise<FrozenCandidate> {
  if (signal?.aborted) throw new UpdaterStateError("cancelled");
  const prepared = await readPreparedUpdate(channelRoot);
  if (prepared.version !== selected.version || prepared.hash !== selected.hash)
    throw new UpdaterStateError("preparedSelection");
  const candidate = await readFrozenCandidate(dataDirectory, selected.hash);
  if (
    candidate.version !== prepared.version ||
    candidate.hash !== prepared.hash ||
    candidate.retained_tar_path !== prepared.retained_tar_path ||
    candidate.prepared_path !== preparedPath(channelRoot)
  )
    throw new UpdaterStateError("candidateRecordMismatch");
  const currentPreparedSha = await hashFile(preparedPath(channelRoot), signal);
  if (currentPreparedSha !== candidate.prepared_sha256)
    throw new UpdaterStateError("preparedRecordChanged");
  if (
    expected &&
    (candidate.version !== expected.version ||
      candidate.hash !== expected.hash ||
      candidate.prepared_path !== expected.prepared_path ||
      candidate.prepared_sha256 !== expected.prepared_sha256 ||
      candidate.retained_tar_path !== expected.retained_tar_path ||
      candidate.archive_sha256 !== expected.archive_sha256 ||
      candidate.archive_bytes !== expected.archive_bytes)
  )
    throw new UpdaterStateError("candidateRecordMismatch");
  if (signal?.aborted) throw new UpdaterStateError("cancelled");
  const info = await lstat(candidate.retained_tar_path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size !== candidate.archive_bytes ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new UpdaterStateError("preparedArchiveChanged");
  if ((await hashFile(candidate.retained_tar_path, signal)) !== candidate.archive_sha256)
    throw new UpdaterStateError("preparedArchiveChanged");
  if (signal?.aborted) throw new UpdaterStateError("cancelled");
  return candidate;
}

export async function discardFrozenCandidate(
  channelRoot: string,
  dataDirectory: string,
  selected: SelectedUpdate,
): Promise<void> {
  await assertUpdateStoragePaths({ channelRoot, dataDirectory });
  await removePrivateFile(candidateRecordPath(dataDirectory, selected.hash));
  const prepared = await readPreparedUpdate(channelRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!prepared || prepared.hash !== selected.hash) return;
  await removePrivateFile(preparedPath(channelRoot));
  const archive = await lstat(prepared.retained_tar_path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (archive) {
    if (
      archive.isSymbolicLink() ||
      !archive.isFile() ||
      (typeof process.getuid === "function" && archive.uid !== process.getuid())
    )
      throw new UpdaterStateError("preparedArchive");
    await rm(prepared.retained_tar_path, { force: true });
  }
}
