import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertManagedDirectory, ensurePrivateDirectory, UpdaterStateError } from "./storage";
import { isWorkerResult, type WorkerResult } from "./worker-protocol";

const MAX_WORKER_OUTPUT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 2_000;

export interface OwnedWorkerOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  deadlineMs: number;
  resultPath: string;
  signal?: AbortSignal;
  fileSizeLimitBytes?: number;
  requireGrant?: boolean;
  onRegistered?: (pid: number, signal?: AbortSignal) => Promise<void>;
  onGranted?: () => void;
  onSettled?: (pid: number) => Promise<void>;
}

export type OwnedWorkerStatus = "completed" | "failed" | "timeout" | "cancelled";

export interface OwnedWorkerOutcome {
  status: OwnedWorkerStatus;
  exitCode: number | null;
  closed: boolean;
  result?: WorkerResult;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

async function waitForClose(
  close: Promise<number | null>,
  milliseconds: number,
): Promise<{ closed: true; code: number | null } | { closed: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      close.then((code) => ({ closed: true as const, code })),
      new Promise<{ closed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ closed: false }), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readWorkerResult(path: string): Promise<WorkerResult> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new UpdaterStateError("workerResult");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new UpdaterStateError("workerResult");
  if ((info.mode & 0o077) !== 0 || info.size <= 0 || info.size > MAX_WORKER_OUTPUT_BYTES)
    throw new UpdaterStateError("workerResult");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let text: string;
  try {
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const value: unknown = JSON.parse(text);
  if (!isWorkerResult(value)) throw new UpdaterStateError("workerResult");
  return value;
}

export async function createRunDirectory(dataDirectory: string): Promise<string> {
  await ensurePrivateDirectory(join(dataDirectory, "updates"));
  await ensurePrivateDirectory(join(dataDirectory, "updates/tmp"));
  const directory = await mkdtemp(join(dataDirectory, "updates/tmp/run-"));
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new UpdaterStateError("workerResult");
  return directory;
}

export async function assertStagingCapacity(path: string, requiredBytes: number): Promise<void> {
  const stats = await statfs(path);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(available) || available < requiredBytes)
    throw new UpdaterStateError("storage");
}

export async function runOwnedWorker(options: OwnedWorkerOptions): Promise<OwnedWorkerOutcome> {
  if (options.signal?.aborted) return { status: "cancelled", exitCode: null, closed: true };
  await mkdir(dirname(options.resultPath), { recursive: true, mode: 0o700 });
  if (options.signal?.aborted) return { status: "cancelled", exitCode: null, closed: true };
  if (
    options.fileSizeLimitBytes !== undefined &&
    (!Number.isSafeInteger(options.fileSizeLimitBytes) || options.fileSizeLimitBytes <= 0)
  )
    throw new UpdaterStateError("guardLimit");
  const limited =
    options.fileSizeLimitBytes !== undefined
      ? {
          command: "/bin/bash",
          args: [
            "-c",
            `ulimit -f ${Math.ceil(options.fileSizeLimitBytes / 1024)} || exit 125; exec "$@"`,
            "mcp-update-worker",
            options.command,
            ...options.args,
          ],
        }
      : { command: options.command, args: [...options.args] };
  const child = spawn(limited.command, limited.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: [options.requireGrant ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stopped: "timeout" | "cancelled" | undefined;
  let closeResolve: (code: number | null) => void = () => {};
  const close = new Promise<number | null>((resolve) => {
    closeResolve = resolve;
  });
  // The operation signal propagates both parent cancellation and the worker
  // deadline to the registration probe, while cleanup/settlement keeps its own
  // bounded lifetime rather than inheriting an already-aborted work signal.
  const operationController = new AbortController();
  const stop = (reason: "timeout" | "cancelled") => {
    if (stopped) return;
    stopped = reason;
    operationController.abort();
    if (pid) killGroup(pid);
  };
  const timer = setTimeout(() => stop("timeout"), options.deadlineMs);
  const abort = () => stop("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_WORKER_OUTPUT_BYTES && pid) stop("timeout");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_WORKER_OUTPUT_BYTES && pid) stop("timeout");
  });
  child.stdin?.on("error", () => {});
  child.on("error", () => {
    if (!stopped) closeResolve(null);
  });
  child.on("close", (code) => closeResolve(code));
  try {
    if (options.requireGrant) {
      try {
        if (!pid) throw new Error("worker pid unavailable");
        if (operationController.signal.aborted) throw new Error("worker operation aborted");
        await options.onRegistered?.(pid, operationController.signal);
        if (stopped) {
          const stoppedExit = await waitForClose(close, TERMINATION_GRACE_MS);
          return {
            status: stopped,
            exitCode: stoppedExit.closed ? stoppedExit.code : null,
            closed: stoppedExit.closed,
          };
        }
        child.stdin?.write("grant\n");
        child.stdin?.end();
        options.onGranted?.();
      } catch {
        if (pid) killGroup(pid);
        const failedExit = await waitForClose(close, TERMINATION_GRACE_MS);
        return {
          status: stopped ?? "failed",
          exitCode: failedExit.closed ? failedExit.code : null,
          closed: failedExit.closed,
        };
      }
    }
    const exit = await waitForClose(close, options.deadlineMs + TERMINATION_GRACE_MS);
    if (!exit.closed) {
      stop("timeout");
      const closedAfterKill = await waitForClose(close, TERMINATION_GRACE_MS);
      return {
        status: "timeout",
        exitCode: closedAfterKill.closed ? closedAfterKill.code : null,
        closed: closedAfterKill.closed,
      };
    }
    if (stopped === "cancelled") return { status: "cancelled", exitCode: exit.code, closed: true };
    if (stopped === "timeout") return { status: "timeout", exitCode: exit.code, closed: true };
    if (pid) killGroup(pid);
    if (exit.code !== 0) return { status: "failed", exitCode: exit.code, closed: true };
    try {
      const result = await readWorkerResult(options.resultPath);
      return { status: "completed", exitCode: exit.code, closed: true, result };
    } catch {
      return { status: "failed", exitCode: exit.code, closed: true };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (options.requireGrant && pid) await options.onSettled?.(pid);
  }
}

const STAGING_FILE_PATTERNS = [
  /^\.?[a-z0-9]{1,13}\.[a-f0-9]{32}\.tar\.zst(?:\.partial)?$/,
  /^[a-z0-9]{1,13}\.tar\.[a-f0-9]{32}\.partial$/,
  /^\.[a-f0-9]{32}\.\d+\.[a-z0-9]{1,13}\.(?:patch(?:\.partial)?|tar\.partial)$/,
  /^\.[a-z0-9]{1,13}\.[a-f0-9]{32}\.frozen$/,
];

function absentCleanupPath(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  return undefined;
}

export async function assertUpdateStoragePaths(options: {
  channelRoot: string;
  dataDirectory: string;
}): Promise<void> {
  // Admit every root before deleting anything, including when later roots are absent.
  for (const directory of [
    options.channelRoot,
    join(options.channelRoot, "self-extraction"),
    options.dataDirectory,
    join(options.dataDirectory, "updates"),
    join(options.dataDirectory, "updates/recovery"),
    join(options.dataDirectory, "updates/candidates"),
    join(options.dataDirectory, "updates/tmp"),
  ])
    await assertManagedDirectory(directory);
}

export async function cleanupInterruptedStaging(options: {
  channelRoot: string;
  dataDirectory: string;
  activeRunDirectory?: string;
}): Promise<number> {
  await assertUpdateStoragePaths(options);
  let removed = 0;
  const staging = join(options.channelRoot, "self-extraction");
  for (const name of (await readdir(staging).catch(absentCleanupPath)) ?? []) {
    if (!STAGING_FILE_PATTERNS.some((pattern) => pattern.test(name))) continue;
    const path = join(staging, name);
    const info = await lstat(path).catch(absentCleanupPath);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
    await rm(path, { force: true });
    removed++;
  }
  const recoveryRoot = join(options.dataDirectory, "updates/recovery");
  for (const name of (await readdir(recoveryRoot).catch(absentCleanupPath)) ?? []) {
    if (!/^\.(?:previous-)?[A-Za-z0-9._-]+\.partial\.app$/.test(name)) continue;
    const path = join(recoveryRoot, name);
    const info = await lstat(path).catch(absentCleanupPath);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
    await rm(path, { recursive: true, force: true });
    removed++;
  }
  const runRoot = join(options.dataDirectory, "updates/tmp");
  for (const name of (await readdir(runRoot).catch(absentCleanupPath)) ?? []) {
    if (!/^run-[A-Za-z0-9]{6,}$/.test(name)) continue;
    const path = join(runRoot, name);
    if (options.activeRunDirectory && path === options.activeRunDirectory) continue;
    const info = await lstat(path).catch(absentCleanupPath);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
    await rm(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
