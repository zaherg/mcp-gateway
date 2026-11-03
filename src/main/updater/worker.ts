import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isHigherStableVersion } from "./candidate";
import {
  MAX_COMPRESSED_ARTIFACT_BYTES,
  MAX_EXPANDED_ARCHIVE_BYTES,
  UPDATER_CHANNEL,
  UPDATER_FEED_URL,
  UPDATER_IDENTIFIER,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";
import { atomicWritePrivateJson } from "./storage";
import { admitSdkRoot } from "./support";
import type { WorkerFailure, WorkerSelected } from "./worker-protocol";

interface LocalInfo {
  identifier: string;
  channel: string;
  baseUrl: string;
  version: string;
}

interface UpdateInfo {
  version: string;
  hash: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string;
}

export interface UpdaterSdk {
  getLocalInfo(): Promise<LocalInfo>;
  checkForUpdate(): Promise<UpdateInfo>;
  downloadUpdate(): Promise<void>;
  updateInfo(): UpdateInfo;
  appDataFolder(): Promise<string>;
}

const MAX_GRANT_BYTES = 64;

/** A registered worker performs no SDK I/O until the parent writes the grant. */
export async function waitForGrant(environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (environment.MCP_GATEWAY_UPDATE_GRANT !== "1") return true;
  process.stdin.setEncoding("utf8");
  return await new Promise<boolean>((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (granted: boolean): void => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("close", onEnd);
      process.stdin.removeListener("error", onEnd);
      resolve(granted);
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (buffer.includes("grant\n")) finish(true);
      else if (Buffer.byteLength(buffer) > MAX_GRANT_BYTES) finish(false);
    };
    const onEnd = (): void => finish(false);
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("close", onEnd);
    process.stdin.on("error", onEnd);
  });
}

function resultPath(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.MCP_GATEWAY_UPDATE_RESULT;
  if (!value || !isAbsolute(value) || value.includes("\0") || resolve(value) !== value)
    return undefined;
  return value;
}

async function publish(path: string, value: WorkerSelected | WorkerFailure): Promise<number> {
  await atomicWritePrivateJson(path, value);
  return value.status === "failed" || value.status === "unavailable" ? 1 : 0;
}

function positiveLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,15}$/.test(value)) throw new Error("invalid download limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("invalid download limit");
  return parsed;
}

async function assertDownloadedBudget(
  updater: UpdaterSdk,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const root = join(await updater.appDataFolder(), "self-extraction");
  const expandedLimit = positiveLimit(
    environment.MCP_GATEWAY_UPDATE_MAX_EXPANDED_BYTES,
    MAX_EXPANDED_ARCHIVE_BYTES,
  );
  const compressedLimit = positiveLimit(
    environment.MCP_GATEWAY_UPDATE_MAX_COMPRESSED_BYTES,
    MAX_COMPRESSED_ARTIFACT_BYTES,
  );
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const info = await lstat(join(root, name)).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error("unowned download state");
    const limit =
      name.endsWith(".tar.zst") || name.endsWith(".tar.zst.partial")
        ? compressedLimit
        : name.endsWith(".tar") || name.endsWith(".tar.partial")
          ? expandedLimit
          : undefined;
    if (limit !== undefined && info.size > limit) throw new Error("download budget exceeded");
  }
}

async function assertAdmittedRoot(
  updater: UpdaterSdk,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const expected = environment.MCP_GATEWAY_UPDATE_CHANNEL_ROOT;
  if (
    !expected ||
    !isAbsolute(expected) ||
    resolve(expected) !== expected ||
    expected.includes("\0")
  )
    throw new Error("Missing admitted updater root");
  const actual = await updater.appDataFolder();
  if (actual !== expected) throw new Error("Updater root changed or is unsupported");
  return actual;
}

async function checkClient(
  updater: UpdaterSdk,
  mode: "check" | "prepare",
  currentVersion: string,
  environment: NodeJS.ProcessEnv,
): Promise<WorkerSelected | WorkerFailure> {
  const channelRoot = await assertAdmittedRoot(updater, environment);
  const check = await updater.checkForUpdate();
  if (check.error !== "") return { status: "failed", reason: "check" };
  if (!check.updateAvailable) return { status: "no-update", reason: "check" };
  if (!UPDATER_STABLE_VERSION_PATTERN.test(check.version))
    return { status: "failed", reason: "version" };
  if (!isHigherStableVersion(currentVersion, check.version))
    return { status: "no-update", reason: "version" };
  await assertAdmittedRoot(updater, environment);
  if (mode === "check")
    return {
      status: "available",
      selected: { version: check.version, hash: check.hash },
      channelRoot,
    };
  await updater.downloadUpdate();
  await assertAdmittedRoot(updater, environment);
  await assertDownloadedBudget(updater, environment);
  const downloaded = updater.updateInfo();
  if (!downloaded.updateReady || downloaded.error !== "")
    return { status: "failed", reason: "download" };
  return {
    status: "ready",
    selected: { version: check.version, hash: check.hash },
    channelRoot,
  };
}

async function loadUpdaterSdk(channelRoot: string): Promise<UpdaterSdk> {
  const { Updater, Utils } = await import("electrobun/main");
  const admit = () =>
    admitSdkRoot(channelRoot, Utils.paths.appData, Utils.resolveInstalledRootNameForPaths);
  return {
    getLocalInfo: async () => {
      await admit();
      return Updater.getLocalInfo();
    },
    checkForUpdate: async () => {
      await admit();
      return Updater.checkForUpdate();
    },
    downloadUpdate: async () => {
      await admit();
      return Updater.downloadUpdate();
    },
    updateInfo: () => Updater.updateInfo(),
    appDataFolder: async () => {
      await admit();
      return Updater.appDataFolder();
    },
  };
}

export async function runUpdaterWorker(
  mode: string,
  environment: NodeJS.ProcessEnv = process.env,
  injected?: UpdaterSdk,
): Promise<number> {
  if (mode !== "check" && mode !== "prepare") return 2;
  const output = resultPath(environment);
  if (!output) return 2;
  if (!(await waitForGrant(environment))) return 2;
  try {
    const channelRoot = environment.MCP_GATEWAY_UPDATE_CHANNEL_ROOT;
    if (!channelRoot) throw new Error("Missing admitted updater root");
    const updater = injected ?? (await loadUpdaterSdk(channelRoot));
    const info = await updater.getLocalInfo();
    if (info.identifier !== UPDATER_IDENTIFIER)
      return publish(output, { status: "unavailable", reason: "identity" });
    if (info.channel !== UPDATER_CHANNEL)
      return publish(output, { status: "unavailable", reason: "channel" });
    if (info.baseUrl !== UPDATER_FEED_URL)
      return publish(output, { status: "unavailable", reason: "feed" });
    if (!UPDATER_STABLE_VERSION_PATTERN.test(info.version))
      return publish(output, { status: "unavailable", reason: "version" });
    return publish(output, await checkClient(updater, mode, info.version, environment));
  } catch {
    return publish(output, { status: "failed", reason: "result" }).catch(() => 2);
  }
}
