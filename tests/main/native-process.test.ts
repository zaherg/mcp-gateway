import { expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  nativeEnvironment,
  nativeLayout,
  ownFixture,
  spawnOwned,
} from "../../scripts/native-process";
import { validateNativeReport } from "../../scripts/native-report";
import { alive, eventually, testDirectory } from "../core/helpers";

test("native layout selects the real Linux development launcher and preserves Mac payloads", () => {
  const root = resolve(".");
  expect(nativeLayout(root, join(root, "build/dev-linux-x64/MCPGateway-dev"), "linux")).toEqual({
    cwd: join(root, "build/dev-linux-x64/MCPGateway-dev/bin"),
    launcher: join(root, "build/dev-linux-x64/MCPGateway-dev/bin/launcher"),
    resources: join(root, "build/dev-linux-x64/MCPGateway-dev/Resources"),
    channel: "dev",
  });
  expect(
    nativeLayout(root, join(root, "build/dev-macos-arm64/MCP Gateway-dev.app"), "macos").channel,
  ).toBe("dev");
  expect(nativeLayout(root, join(root, ".cache/payload/MCP Gateway.app"), "macos").channel).toBe(
    "stable",
  );
  expect(() => nativeLayout(root, "/outside/MCPGateway-dev", "linux")).toThrow(
    "inside the project",
  );
  expect(() =>
    nativeLayout(root, join(root, "build/stable-linux-x64/MCPGateway"), "linux"),
  ).toThrow("development bundle");
});

test("native environment preserves only required display fields and isolated local directories", () => {
  const source = {
    PATH: "/synthetic/bin",
    DISPLAY: ":81",
    XAUTHORITY: "/synthetic/auth",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/bus",
    PRIVATE_TOKEN: "not-in-child",
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1",
    HOME: "/real-home",
  };
  const env = nativeEnvironment("/synthetic/run", "linux", source);
  expect(env.DISPLAY).toBe(":81");
  expect(env.XAUTHORITY).toBe(source.XAUTHORITY);
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(source.DBUS_SESSION_BUS_ADDRESS);
  expect(env.HOME).toBe("/synthetic/run/home");
  expect(env.XDG_RUNTIME_DIR).toBe("/synthetic/run/runtime");
  expect(env.XDG_CONFIG_HOME).toBe("/synthetic/run/home/config");
  expect(env.MCP_GATEWAY_ISOLATED).toBe("1");
  expect(env.LIBGL_ALWAYS_SOFTWARE).toBe("1");
  expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
  expect(env.PRIVATE_TOKEN).toBeUndefined();
  expect(env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS).toBeUndefined();
  expect(nativeEnvironment("/synthetic/run", "macos", source).DISPLAY).toBeUndefined();
  for (const field of ["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"])
    expect(() => nativeEnvironment("/synthetic/run", "linux", { ...source, [field]: "" })).toThrow(
      field,
    );
});

const linuxReport = () => ({
  phase: "closed",
  platform: "linux",
  renderer: "WebKitGTK",
  shortcuts: "not-tested",
  smokeError: null,
  quitMethod: "renderer",
  quitRequested: true,
  configFormat: "json",
  configError: null,
  renderedWindows: 2,
  closePreservedState: true,
  closeRequestedHandled: true,
  minimizeObserved: true,
  restoreObserved: true,
  closeShortcutHandled: false,
  shortcutHandled: false,
  nativeLoginStatus: null,
  loginSupported: false,
  running: false,
  serverCount: 0,
  viewportPolicy: {
    supported: true,
    documentOverscroll: "none",
    bodyOverscroll: "none",
    bodyBackground: "rgb(247, 249, 251)",
  },
});
const options = {
  platform: "linux",
  format: "json",
  fresh: true,
  signal: false,
  closed: true,
} as const;
test("native report fails missing lifecycle/renderer/login/shutdown behavior instead of skipping Linux", () => {
  expect(() => validateNativeReport(linuxReport(), options)).not.toThrow();
  for (const field of [
    "minimizeObserved",
    "restoreObserved",
    "closePreservedState",
    "closeRequestedHandled",
    "quitRequested",
  ])
    expect(() => validateNativeReport({ ...linuxReport(), [field]: false }, options)).toThrow();
  for (const [field, value] of [
    ["shortcuts", "Cocoa app-local"],
    ["loginSupported", true],
    ["nativeLoginStatus", -1],
    ["smokeError", "failed"],
    ["renderedWindows", 1],
    ["running", true],
    ["viewportPolicy", {}],
  ])
    expect(() =>
      validateNativeReport({ ...linuxReport(), [String(field)]: value }, options),
    ).toThrow();
  expect(() =>
    validateNativeReport({ ...linuxReport(), quitMethod: "SIGTERM" }, { ...options, signal: true }),
  ).not.toThrow();
  expect(() => validateNativeReport(linuxReport(), { ...options, signal: true })).toThrow();
  const legacy = {
    ...linuxReport(),
    platform: undefined,
    closeShortcutHandled: true,
    shortcutHandled: true,
    nativeLoginStatus: 0,
  };
  expect(() => validateNativeReport(legacy, { ...options, platform: "macos" })).not.toThrow();
});

test("owned process cleanup covers launcher runtime and detached fixture without touching an unrelated process", async () => {
  const directory = await testDirectory();
  const env = nativeEnvironment(directory, "macos", process.env);
  await mkdir(env.HOME);
  const runtimePid = join(directory, "runtime.pid");
  const fixturePid = join(directory, "fixture.pid");
  const fixturePath = resolve("tests/fixtures/native-owned.ts");
  const launcher = spawnOwned(
    [
      process.execPath,
      "-e",
      `
    Bun.spawn([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)", ${JSON.stringify(runtimePid)}], {stdout:'inherit',stderr:'inherit'});
    Bun.spawn([process.execPath, ${JSON.stringify(fixturePath)}, ${JSON.stringify(directory)}, ${JSON.stringify(fixturePid)}], {detached:true,stdout:'inherit',stderr:'inherit'});
    setInterval(()=>{},1000);
  `,
    ],
    directory,
    env,
  );
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let fixture: Awaited<ReturnType<typeof ownFixture>> = null;
  try {
    await eventually(
      async () => (await Bun.file(runtimePid).exists()) && (await Bun.file(fixturePid).exists()),
    );
    const pid = Number(await readFile(fixturePid, "utf8"));
    const runtime = Number(await readFile(runtimePid, "utf8"));
    fixture = await ownFixture(pid, fixturePath, directory);
    expect(fixture).not.toBeNull();
    await expect(ownFixture(unrelated.pid, fixturePath, directory)).rejects.toThrow("not owned");
    await launcher.stop();
    await fixture?.stop();
    await eventually(() => !alive(runtime) && !alive(pid));
    expect(alive(unrelated.pid)).toBe(true);
  } finally {
    try {
      await launcher.stop();
    } finally {
      try {
        await fixture?.stop();
      } finally {
        unrelated.kill("SIGTERM");
        await unrelated.exited;
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 30_000);

test("owned fixture cleanup survives a sleeping-to-stopped state transition", async () => {
  const directory = await testDirectory();
  const fixturePath = resolve("tests/fixtures/native-owned.ts");
  const pidFile = join(directory, "stopped.pid");
  const child = Bun.spawn([process.execPath, fixturePath, directory, pidFile], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exited = child.exited;
  async function state() {
    const ps = Bun.spawn(["ps", "-p", String(child.pid), "-o", "stat="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(ps.stdout).text();
    if ((await ps.exited) !== 0) throw new Error("Directly owned fixture was not inspectable.");
    return text.trim();
  }
  try {
    await eventually(
      async () => (await Bun.file(pidFile).exists()) && (await state()).startsWith("S"),
    );
    const owned = await ownFixture(child.pid, fixturePath, directory);
    expect(owned).not.toBeNull();
    child.kill("SIGSTOP");
    await eventually(async () => (await state()).startsWith("T"));
    await owned?.stop();
    await exited;
    expect(alive(child.pid)).toBe(false);
  } finally {
    // The Bun handle owns this exact child even if the regression assertion fails.
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
