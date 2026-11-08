import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import type {
  ChildrenOwner,
  GatewayLogger,
} from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";

interface CommandResult {
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

interface CommandChild {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  kill(signal: "SIGKILL"): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

type CommandStart = (command: string, args: readonly string[]) => CommandChild;

interface CreateCommandRunnerOptions {
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  start?: CommandStart;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;

export const createCommandRunner = (options?: CreateCommandRunnerOptions): CommandRunner => {
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
};

export const runCommand = createCommandRunner();

interface GroupMember {
  pid: number;
  start: string;
}
type BackendGroup =
  | { status: "absent" }
  | { status: "unknown" }
  | { status: "present"; members: GroupMember[] };

const runInspection = createCommandRunner({ defaultTimeoutMs: 2_000, maxOutputBytes: 16 * 1024 });

const inspectBackendGroup = async (pgid: number): Promise<BackendGroup> => {
  const run = runInspection;
  try {
    const listed = await run("/usr/bin/pgrep", ["-g", String(pgid)]);
    if (listed.exitCode === 1 && !listed.stdout.trim() && !listed.stderr.trim())
      return { status: "absent" };
    if (listed.exitCode !== 0 || listed.stderr.trim()) return { status: "unknown" };
    const ids = listed.stdout.trim().split(/\s+/);
    if (
      !ids.length ||
      ids.length > 128 ||
      ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    )
      return { status: "unknown" };
    const inspected = await run("/bin/ps", [
      "-p",
      ids.join(","),
      "-o",
      "pid=",
      "-o",
      "pgid=",
      "-o",
      "uid=",
      "-o",
      "lstart=",
    ]);
    if (inspected.exitCode !== 0 || inspected.stderr.trim()) return { status: "unknown" };
    const members: GroupMember[] = [];
    for (const line of inspected.stdout.trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (
        !match ||
        !ids.includes(match[1] ?? "") ||
        Number(match[2]) !== pgid ||
        Number(match[3]) !== process.getuid?.() ||
        !match[4]
      )
        return { status: "unknown" };
      members.push({ pid: Number(match[1]), start: match[4] });
    }
    if (members.length !== ids.length || new Set(members.map(({ pid }) => pid)).size !== ids.length)
      return { status: "unknown" };
    return { status: "present", members };
  } catch {
    return { status: "unknown" };
  }
};

// Signal 0 checks existence without spawning pgrep; ESRCH means no process is
// left in the group. Any other answer falls through to the identity inspection.
const groupGone = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_MS = 50;
// Unconfirmed groups are only inspected, so a fast poll would waste CPU forever.
const STUCK_POLL_MS = 1_000;

/** A cleanup stays owned through uncertain inspection or refused termination. */
export class BackendProcesses implements ChildrenOwner {
  closing = false;
  readonly spawnOptions: SpawnOptions = { shell: false, detached: true };
  private readonly stops = new Set<() => Promise<void>>();

  constructor(private readonly logger: GatewayLogger) {}

  track(stop: () => Promise<void>): () => Promise<void> {
    let operation: Promise<void> | undefined;
    const once = () =>
      (operation ??= Promise.resolve()
        .then(stop)
        .then(() => {
          this.stops.delete(once);
        }));
    this.stops.add(once);
    return once;
  }

  own(child: ChildProcess): () => Promise<void> {
    const pid = child.pid;
    const running = () => child.exitCode === null && child.signalCode === null;
    const exited = new Promise<void>((resolve) => {
      if (!running()) resolve();
      else {
        child.once("exit", resolve);
        child.once("close", resolve);
      }
    });
    let known = new Map<number, string>();
    const remember = (state: BackendGroup): boolean => {
      if (state.status !== "present") return false;
      const trusted = running()
        ? state.members.some((member) => member.pid === pid)
        : state.members.some((member) => known.get(member.pid) === member.start);
      if (trusted) known = new Map(state.members.map(({ pid, start }) => [pid, start]));
      return trusted;
    };
    // Capture while the ChildProcess still proves the leader's identity.
    const registration =
      pid === undefined
        ? Promise.resolve()
        : inspectBackendGroup(pid).then((state) => {
            remember(state);
          });
    const stop = this.track(async () => {
      await registration;
      if (pid === undefined) {
        await exited;
        return;
      }
      const deadline = Date.now() + TERMINATION_GRACE_MS;
      let reported = false;
      for (;;) {
        if (groupGone(pid)) {
          await exited;
          return;
        }
        const state = await inspectBackendGroup(pid);
        if (state.status === "absent") {
          await exited;
          return;
        }
        if (remember(state)) {
          try {
            process.kill(-pid, Date.now() < deadline ? "SIGTERM" : "SIGKILL");
          } catch (error) {
            // ESRCH is rechecked, and EPERM never means successful termination.
            if ((error as NodeJS.ErrnoException).code !== "ESRCH" && !reported) {
              reported = true;
              this.logger.error("Backend process-group termination is unconfirmed.");
            }
          }
        } else if (!reported) {
          reported = true;
          this.logger.error(
            "Backend process-group identity could not be confirmed; cleanup remains pending.",
          );
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Date.now() < deadline ? TERMINATION_POLL_MS : STUCK_POLL_MS),
        );
      }
    });
    const stopOnExit = () => {
      void stop().catch((error: unknown) => this.logger.error(error));
    };
    child.once("exit", stopOnExit);
    child.once("error", stopOnExit);
    return stop;
  }

  async close(): Promise<void> {
    this.closing = true;
    while (this.stops.size) await Promise.all([...this.stops].map((stop) => stop()));
  }
}
