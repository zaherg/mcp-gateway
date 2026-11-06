import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { newConfigText } from "../src/core/config";
import { desktopPlatform } from "../src/main/platform";
import { nativeEnvironment, nativeLayout, spawnOwned } from "./native-process";
import { nativeReport, validateNativeReport } from "./native-report";

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
