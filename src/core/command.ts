import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

export interface CommandChild {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  kill(signal: "SIGKILL"): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

export type CommandStart = (command: string, args: readonly string[]) => CommandChild;

export interface CreateCommandRunnerOptions {
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  start?: CommandStart;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;

export function createCommandRunner(options?: CreateCommandRunnerOptions): CommandRunner {
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES;
  for (const limit of [defaultTimeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid command limit");
  }
  const start: CommandStart =
    options?.start ??
    ((command, args) =>
      spawn(command, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }));

  return (command, args, timeoutMs = defaultTimeoutMs, signal) =>
    new Promise((resolvePromise, reject) => {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        reject(new Error("Invalid command deadline"));
        return;
      }
      if (signal?.aborted) {
        reject(new Error("Command cancelled"));
        return;
      }

      const child = start(command, args);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let termination: Error | undefined;
      let abortHandler: (() => void) | undefined;

      const finish = (result: CommandResult | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        if (result instanceof Error) reject(result);
        else resolvePromise(result);
      };

      const terminate = (error: Error) => {
        if (settled || termination) return;
        termination = error;
        try {
          child.kill("SIGKILL");
        } catch (failure) {
          termination =
            failure instanceof Error ? failure : new Error("Command termination failed");
        }
        // Ownership stays unsettled until close, even if termination is unconfirmed.
      };

      const timer = setTimeout(() => terminate(new Error("Command timed out")), timeoutMs);

      abortHandler = () => terminate(new Error("Command cancelled"));

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= maxOutputBytes) stdout.push(chunk);
        else terminate(new Error("Command output exceeded the limit"));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= maxOutputBytes) stderr.push(chunk);
        else terminate(new Error("Command output exceeded the limit"));
      });

      child.on("error", (error) => {
        if (child.pid === undefined) finish(error);
        else terminate(error);
      });

      child.on("close", (code) => {
        if (termination) {
          finish(termination);
          return;
        }
        if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
          finish(new Error("Command output exceeded the limit"));
          return;
        }
        finish({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? -1,
        });
      });
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) terminate(new Error("Command cancelled"));
    });
}

export const runCommand = createCommandRunner();
