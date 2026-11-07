import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { newConfigText } from "../src/core/config";
import { desktopPlatform } from "../src/main/platform";
import type { DesktopPlatform } from "../src/shared/rpc";

function nativeLayout(root: string, bundle: string, platform: DesktopPlatform) {
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

function nativeEnvironment(
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
function spawnOwned(command: string[], cwd: string, env: Record<string, string>) {
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

function nativeReport(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native report.");
  return Object.fromEntries(Object.entries(value));
}

function validateNativeReport(
  report: Record<string, unknown>,
  options: {
    platform: DesktopPlatform;
    closed: boolean;
  },
): void {
  const { platform, closed } = options;
  const linux = platform === "linux";
  // Older signed macOS payloads retain their existing report interpretation.
  const legacy = !linux && report.platform === undefined;
  const policy = nativeReport(report.viewportPolicy);
  if (
    policy.supported !== true ||
    policy.documentOverscroll !== "none" ||
    policy.bodyOverscroll !== "none" ||
    policy.bodyBackground !== "rgb(247, 249, 251)"
  )
    throw new Error("Native renderer scroll/canvas policy verification failed.");
  if (
    report.configFormat !== "json" ||
    report.configError !== null ||
    report.running !== false ||
    report.serverCount !== 0
  )
    throw new Error("Native configuration/default-state verification failed.");
  if (
    !legacy &&
    (report.platform !== platform ||
      report.smokeError !== null ||
      report.renderer !== (linux ? "WebKitGTK" : "WKWebView") ||
      report.shortcuts !== (linux ? "not-tested" : "Cocoa app-local"))
  )
    throw new Error("Native platform/report verification failed.");
  if (
    report.phase !== (closed ? "closed" : "ready") ||
    report.renderedWindows !== 2 ||
    report.closePreservedState !== true ||
    (!linux && report.closeShortcutHandled !== true) ||
    (linux &&
      (report.closeRequestedHandled !== true ||
        report.minimizeObserved !== true ||
        report.restoreObserved !== true ||
        report.closeShortcutHandled !== false ||
        report.shortcutHandled !== false ||
        report.nativeLoginStatus !== null ||
        report.loginSupported !== false))
  )
    throw new Error("Native close/restore/recreation verification failed.");
  if (
    closed &&
    (report.running !== false ||
      (linux
        ? report.quitRequested !== true || report.quitMethod !== "renderer"
        : report.shortcutHandled !== true))
  )
    throw new Error("Native graceful shutdown verification failed.");
}

const root = resolve(import.meta.dir, "..");
const platform = desktopPlatform(process.platform);
const bundle = resolve(
  process.argv[2] ??
    join(
      root,
      platform === "macos"
        ? "build/dev-macos-arm64/MCP Gateway-dev.app"
        : `build/dev-linux-${process.arch}/MCPGateway-dev`,
    ),
);
const layout = nativeLayout(root, bundle, platform);
if (existsSync(join(layout.resources, "metadata.json")))
  throw new Error(
    "Use a development bundle or extracted signed payload, not a self-replacing installer wrapper.",
  );
if (!existsSync(layout.launcher)) throw new Error("Native bundle launcher is missing.");
const evidenceRoot = resolve(root, process.argv[3] ?? ".cache/native-check");
if (relative(root, evidenceRoot).startsWith(".."))
  throw new Error("Native evidence must remain inside the project.");
const runRoot = join(evidenceRoot, `${layout.channel}-${Date.now()}`);
await mkdir(runRoot, { recursive: true, mode: 0o700 });
if (platform === "linux") {
  for (const library of ["launcher", "libElectrobunCore.so", "libNativeWrapper.so", "libasar.so"]) {
    const ldd = Bun.spawn(["ldd", join(layout.cwd, library)], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(ldd.stdout).text(),
      new Response(ldd.stderr).text(),
      ldd.exited,
    ]);
    await writeFile(join(runRoot, `${library}.ldd.log`), `${stdout}\n${stderr}`, { mode: 0o600 });
    if (code !== 0 || stdout.includes("not found"))
      throw new Error(`Missing native dependencies for ${library}.`);
  }
}

async function runFresh(): Promise<void> {
  const directory = join(runRoot, "fresh");
  const env = nativeEnvironment(directory, platform, process.env);
  env.MCP_GATEWAY_SMOKE_QUIT = "control";
  for (const child of [
    directory,
    env.HOME,
    env.TMPDIR,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME,
    env.XDG_RUNTIME_DIR,
  ])
    await mkdir(child, { recursive: true, mode: 0o700 });
  const owned = spawnOwned([layout.launcher], layout.cwd, env);
  const processHandle = owned.child;
  const output = Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  const timeout = setTimeout(() => owned.signal(), 55_000);
  async function waitReport(phases: string[]): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const report = nativeReport(
          JSON.parse(await readFile(join(directory, "native-smoke.json"), "utf8")),
        );
        if (phases.includes(String(report.phase))) return report;
        if (report.phase === "closed")
          throw new Error("Native app closed before completing acceptance.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      if (processHandle.exitCode !== null) break;
      await Bun.sleep(100);
    }
    throw new Error("Native app did not complete real renderer RPC before the deadline.");
  }
  try {
    const initial = await waitReport(["window-ready", "ready"]);
    if (initial.phase === "window-ready")
      await writeFile(join(directory, "native-smoke-continue"), "continue\n", { mode: 0o600 });
    const report = initial.phase === "ready" ? initial : await waitReport(["ready"]);
    const options = { platform, closed: false } as const;
    validateNativeReport(report, options);
    if (layout.channel === "stable" && report.nativeLoginStatus === -1)
      throw new Error("Signed app does not resolve the expected login-service bundle.");
    const exit = await Promise.race([
      processHandle.exited,
      Bun.sleep(20_000).then(() => {
        throw new Error("Native graceful shutdown timed out.");
      }),
    ]);
    const final = nativeReport(
      JSON.parse(await readFile(join(directory, "native-smoke.json"), "utf8")),
    );
    validateNativeReport(final, { ...options, closed: true });
    if (exit !== 0) throw new Error("Native launcher exit status failed.");
    console.log(
      `${layout.channel} fresh: real renderer RPC, window recreation, ${platform === "linux" ? "minimize/restore; shortcuts not tested" : "Cocoa Cmd+W"}, ${platform === "linux" ? "renderer Quit" : "Cocoa Cmd+Q"} passed.`,
    );
  } finally {
    clearTimeout(timeout);
    try {
      await owned.stop();
    } finally {
      const [stdout, stderr] = await output;
      await writeFile(join(directory, "process.log"), `${stdout}\n${stderr}`, { mode: 0o600 });
      console.log(`Native evidence: ${directory}`);
    }
  }
}
await runFresh();
if (JSON.parse(newConfigText()).gateway.autoStart !== false)
  throw new Error("Unsafe initial configuration.");
