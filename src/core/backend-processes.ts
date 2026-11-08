import type { ChildProcess, SpawnOptions } from "node:child_process";
import type {
  ChildrenOwner,
  GatewayLogger,
} from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import { type CommandRunner, createCommandRunner } from "./command";

export interface GroupMember {
  pid: number;
  start: string;
}
export type BackendGroup =
  | { status: "absent" }
  | { status: "unknown" }
  | { status: "present"; members: GroupMember[] };

const runInspection = createCommandRunner({ defaultTimeoutMs: 2_000, maxOutputBytes: 16 * 1024 });

export async function inspectBackendGroup(
  pgid: number,
  run: CommandRunner = runInspection,
): Promise<BackendGroup> {
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
}

interface ProcessOptions {
  inspect?: (pgid: number) => Promise<BackendGroup>;
  signal?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  graceMs?: number;
  pollMs?: number;
}

/** A cleanup stays owned through uncertain inspection or refused termination. */
export class BackendProcesses implements ChildrenOwner {
  closing = false;
  readonly spawnOptions: SpawnOptions = { shell: false, detached: true };
  private readonly stops = new Set<() => Promise<void>>();

  constructor(
    private readonly logger: GatewayLogger,
    private readonly options: ProcessOptions = {},
  ) {}

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
    const inspect = this.options.inspect ?? inspectBackendGroup;
    const signal =
      this.options.signal ??
      ((pgid, name) => {
        process.kill(-pgid, name);
      });
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
        : inspect(pid).then((state) => {
            remember(state);
          });
    const stop = this.track(async () => {
      await registration;
      if (pid === undefined) {
        await exited;
        return;
      }
      const deadline = Date.now() + (this.options.graceMs ?? 5_000);
      let reported = false;
      for (;;) {
        const state = await inspect(pid);
        if (state.status === "absent") {
          await exited;
          return;
        }
        if (remember(state)) {
          try {
            signal(pid, Date.now() < deadline ? "SIGTERM" : "SIGKILL");
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
        await new Promise<void>((resolve) => setTimeout(resolve, this.options.pollMs ?? 50));
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
