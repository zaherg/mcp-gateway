import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { newConfigText } from "../src/core/config";
import { desktopPlatform } from "../src/main/platform";
import { alive, configFor, connect, fixture, pids, stdio } from "../tests/core/helpers";
import { nativeEnvironment, nativeLayout, ownFixture, spawnOwned } from "./native-process";
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

for (const scenario of ["fresh", "synthetic", "jsonc", "sigterm"] as const) {
  const directory = join(runRoot, scenario);
  const signal = scenario === "sigterm";
  const env = nativeEnvironment(directory, platform, process.env);
  env.MCP_GATEWAY_SMOKE_QUIT = signal ? "signal" : "control";
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
  let address: string | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  const pidFile = join(directory, "pids");
  if (scenario !== "fresh") {
    const backend = stdio({ PID_FILE: pidFile });
    // Unique command marker lets emergency cleanup prove ownership even after reparenting.
    backend.args = [fixture, directory];
    const config = await configFor({ echo: backend });
    config.gateway.autoStart = true;
    if (platform === "linux") config.gateway.launchAtLogin = true; // Must not hide an unsupported-login window.
    await writeFile(
      join(directory, scenario === "jsonc" ? "mcp.jsonc" : "mcp.json"),
      scenario === "jsonc"
        ? `// Native JSONC fixture\n${JSON.stringify(config, null, 2).replace(/\n}$/, ",\n}")}\n`
        : JSON.stringify(config),
      { mode: 0o600 },
    );
    address = `http://127.0.0.1:${config.gateway.port}`;
  }
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
    if (address) {
      client = await connect(address);
      const reply = await client.client.callTool({
        name: "echo",
        arguments: { value: "native-bundle" },
      });
      if (reply.isError || !JSON.stringify(reply).includes("native-bundle"))
        throw new Error("Packaged MCP protocol verification failed.");
      // Stateless echo discards its own child; retain one so the lifecycle
      // assertions observe a live backend until Quit cleans it up.
      await client.client.callTool({ name: "ask", arguments: { value: "retained" } });
      if (!(await pids(pidFile)).some(alive))
        throw new Error("No live synthetic child before window lifecycle.");
    }
    if (initial.phase === "window-ready")
      await writeFile(join(directory, "native-smoke-continue"), "continue\n", { mode: 0o600 });
    const report = initial.phase === "ready" ? initial : await waitReport(["ready"]);
    const options = {
      platform,
      format: scenario === "jsonc" ? "jsonc" : "json",
      fresh: scenario === "fresh",
      signal,
      closed: false,
    } as const;
    validateNativeReport(report, options);
    if (layout.channel === "stable" && report.nativeLoginStatus === -1)
      throw new Error("Signed app does not resolve the expected login-service bundle.");
    if (client) {
      const reply = await client.client.callTool({
        name: "echo",
        arguments: { value: "after-window-recreation" },
      });
      if (reply.isError || !JSON.stringify(reply).includes("after-window-recreation"))
        throw new Error("Live MCP client did not survive the window lifecycle.");
      if (!(await pids(pidFile)).some(alive))
        throw new Error("No live synthetic child before Quit.");
    }
    // Keep the client session live: cleanup must come from native Quit, not DELETE.
    if (signal) owned.signal();
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
    // A SIGTERM-forwarding launcher may retain its own signal exit status.
    if (exit !== 0 && !(signal && exit === 143))
      throw new Error("Native launcher exit status failed.");
    if ((await pids(pidFile)).some(alive))
      throw new Error("Native shutdown left an owned fixture alive.");
    console.log(
      `${layout.channel} ${scenario}: real renderer RPC, state/log retention, window recreation, ${platform === "linux" ? "minimize/restore; shortcuts not tested" : "Cocoa Cmd+W"}, ${signal ? "SIGTERM" : platform === "linux" ? "renderer Quit" : "Cocoa Cmd+Q"} cleanup passed.`,
    );
  } finally {
    clearTimeout(timeout);
    let fixtures: Array<Awaited<ReturnType<typeof ownFixture>>> = [];
    try {
      fixtures = await Promise.all(
        (await pids(pidFile)).map((pid) => ownFixture(pid, fixture, directory)),
      );
    } finally {
      try {
        await owned.stop();
      } finally {
        await Promise.all(fixtures.map((entry) => entry?.stop()));
        await client?.client.close();
        const [stdout, stderr] = await output;
        await writeFile(join(directory, "process.log"), `${stdout}\n${stderr}`, { mode: 0o600 });
        console.log(`Native evidence: ${directory}`);
      }
    }
  }
}
if (JSON.parse(newConfigText()).gateway.autoStart !== false)
  throw new Error("Unsafe initial configuration.");
