import { join, relative, resolve } from "node:path";
import type { DesktopPlatform } from "../src/shared/rpc";

export function nativeLayout(root: string, bundle: string, platform: DesktopPlatform) {
  const path = resolve(bundle);
  if (relative(root, path).startsWith("..") || !relative(root, path))
    throw new Error("Native bundle must be inside the project.");
  if (platform === "linux" && !path.endsWith("/MCPGateway-dev"))
    throw new Error("Linux native smoke requires a development bundle, not an installer.");
  const cwd = join(path, platform === "macos" ? "Contents/MacOS" : "bin");
  return {
    cwd,
    launcher: join(cwd, "launcher"),
    resources: join(path, platform === "macos" ? "Contents/Resources" : "Resources"),
    channel: platform === "linux" || path.endsWith("-dev.app") ? "dev" : "stable",
  };
}

export function nativeEnvironment(
  directory: string,
  platform: DesktopPlatform,
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const home = join(directory, "home");
  const env: Record<string, string> = {
    PATH: source.PATH ?? "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: join(directory, "tmp"),
    TMP: join(directory, "tmp"),
    TEMP: join(directory, "tmp"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(directory, "runtime"),
    MCP_GATEWAY_DATA_DIR: directory,
    MCP_GATEWAY_ISOLATED: "1",
    MCP_GATEWAY_SMOKE: "1",
  };
  if (platform === "linux") {
    for (const field of ["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"] as const) {
      const value = source[field];
      if (!value || /[\0\r\n]/.test(value))
        throw new Error(`Native Linux smoke requires ${field}.`);
      env[field] = value;
    }
    // Rendering workarounds only. Never inherit sandbox-disabling flags or user settings.
    env.LIBGL_ALWAYS_SOFTWARE = "1";
    env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
  }
  return env;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error("Invalid owned process group.");
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function groupExists(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    // macOS can report EPERM for a zombie-only group. Inspect state, never
    // reinterpret a permission error on a live process as successful cleanup.
    const ps = Bun.spawn(["ps", "-axo", "pgid=,uid=,stat="], { stdout: "pipe", stderr: "pipe" });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (code !== 0) throw error;
    const members = text
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([group]) => Number(group) === pid);
    if (
      members.length > 0 &&
      members.every(
        ([, uid, state]) => Number(uid) === process.getuid?.() && state?.startsWith("Z"),
      )
    )
      return false;
    // A reaped zombie may disappear between kill and ps. Require ESRCH on a
    // second syscall; missing rows alone do not establish successful cleanup.
    if (members.length === 0) {
      try {
        process.kill(-pid, 0);
      } catch (retry) {
        if ((retry as NodeJS.ErrnoException).code === "ESRCH") return false;
      }
    }
    throw error;
  }
  return true;
}

async function waitGone(pid: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while ((await groupExists(pid)) && Date.now() < deadline) await Bun.sleep(50);
  return !(await groupExists(pid));
}

/** Each launcher gets setsid(), so escalation can never reach a user's app group. */
export function spawnOwned(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = child.exited;
  let stopping: Promise<void> | undefined;
  return {
    child,
    signal: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        if (!(await waitGone(child.pid, 10_000))) {
          signalGroup(child.pid, "SIGTERM");
          if (!(await waitGone(child.pid, 2_000))) signalGroup(child.pid, "SIGKILL");
        }
        await Promise.race([
          exited,
          Bun.sleep(3_000).then(() => {
            throw new Error("Owned launcher did not exit after cleanup.");
          }),
        ]);
        if (!(await waitGone(child.pid, 3_000)))
          throw new Error("Owned runtime group survived cleanup.");
      })();
      return stopping;
    },
  };
}

async function fixtureIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid fixture PID.");
  const ps = Bun.spawn(["ps", "-ww", "-p", String(pid), "-o", "pgid=,stat=,lstart=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  if (code === 1 && !text.trim()) return null;
  if (code !== 0) throw new Error("Could not inspect owned fixture process.");
  const row = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(text);
  if (!row) throw new Error("Could not parse owned fixture identity.");
  if (row[2].startsWith("Z")) return null;
  // Scheduling state changes independently of ownership. Compare only the
  // captured PID, process group, start time, and full synthetic command.
  return `${row[1]} ${pid} ${row[3]}`;
}

/** Backends deliberately start separate groups. Only this unique synthetic command is eligible. */
export async function ownFixture(pid: number, fixture: string, marker: string) {
  const identity = await fixtureIdentity(pid);
  if (!identity) return null;
  if (Number(identity.split(/\s+/)[0]) !== pid || !identity.includes(`${fixture} ${marker}`))
    throw new Error("Refusing cleanup of a process not owned by this native fixture.");
  return {
    async stop(): Promise<void> {
      const current = await fixtureIdentity(pid);
      if (current === null) return;
      if (current !== identity) throw new Error("Owned fixture identity changed before cleanup.");
      signalGroup(pid, "SIGTERM");
      if (!(await waitGone(pid, 2_000))) {
        if ((await fixtureIdentity(pid)) !== identity)
          throw new Error("Fixture identity changed during cleanup.");
        signalGroup(pid, "SIGKILL");
        if (!(await waitGone(pid, 3_000))) throw new Error("Owned fixture group survived cleanup.");
      }
    },
  };
}
