import { beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createRPC,
  type RPCSchema,
  type RPCTransport,
} from "../../../.hutch/devkit/api/shared/rpc";
import { spawnOwned } from "../../../scripts/native-process";
import { TransactionLease } from "../../../src/main/updater/transaction";
import { runCommand } from "../../../src/main/updater/verify";
import {
  assertFixtureBase,
  FIXTURE_CACHE,
  FIXTURE_FEED,
  FIXTURE_VERSIONS,
  fixtureRunRoot,
  installHooks,
  patchEntrypoint,
} from "./prepare-fixture-apps";
import {
  assertFailurePrerequisites,
  assertNoUpdateTransaction,
  fixtureProcesses,
  inspectApp,
  stopApp,
} from "./product-update-flow";
import { waitForFixtureHelper } from "./settle-product-helper";

const nativeTest = test.skipIf(process.platform !== "darwin");
beforeAll(async () => {
  await mkdir(resolve(".cache"), { recursive: true });
});

test("maintained acceptance sources use tracked helpers and the default unit command", async () => {
  const packageInfo = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  expect(packageInfo.scripts["test:unit"]).toContain("tests/native/update-acceptance");
  for (const file of [
    "prepare-fixture-apps.ts",
    "product-update-flow.ts",
    "settle-product-helper.ts",
    "native-failures.ts",
    "ui-update-visual.ts",
  ]) {
    const source = await readFile(join(import.meta.dir, file), "utf8");
    expect(source).not.toContain(".cache/auto-update-0.3.1");
  }
  expect(FIXTURE_CACHE).toBe(resolve(".cache/update-acceptance"));
  expect(FIXTURE_FEED).toBe("http://127.0.0.1:47831/releases/latest/download");
  expect(FIXTURE_VERSIONS).toEqual({ initial: "0.3.1", target: "0.3.2" });
});

test("private renderer confirmation uses a bounded timeout longer than its interaction sequence", async () => {
  type Local = RPCSchema<{ requests: Record<string, never>; messages: Record<string, never> }>;
  type Remote = RPCSchema<{
    requests: { fixtureRestart: { params: undefined; response: string } };
    messages: Record<string, never>;
  }>;
  let receive!: Parameters<NonNullable<RPCTransport["registerHandler"]>>[0];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const rpc = createRPC<Local, Remote>({
    transport: {
      registerHandler(handler) {
        receive = handler;
      },
      send(packet) {
        if (packet.type === "request")
          timers.push(
            setTimeout(
              () => receive({ type: "response", id: packet.id, success: true, payload: "clicked" }),
              1_400,
            ),
          );
      },
    },
  });
  try {
    await expect(rpc.request.fixtureRestart()).rejects.toThrow("RPC request timed out.");
    await expect(rpc.request.fixtureRestart(undefined, { maxRequestTime: 15_000 })).resolves.toBe(
      "clicked",
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}, 10_000);

nativeTest(
  "failure transaction absence rejects live, malformed, and leftover native records",
  async () => {
    const root = await mkdtemp(resolve(".cache/acceptance-transaction-"));
    const channel = join(root, "channel");
    let lease: TransactionLease | undefined;
    try {
      await mkdir(channel, { mode: 0o700 });
      await expect(assertNoUpdateTransaction(channel)).resolves.toBeUndefined();
      lease = await TransactionLease.acquire({
        channelRoot: channel,
        dataDirectory: join(root, "data"),
        appBundlePath: join(root, "Fixture.app"),
      });
      await expect(assertNoUpdateTransaction(channel)).rejects.toThrow();
      await lease.releaseUncommitted();
      lease = undefined;
      const directory = join(channel, ".mcp-gateway-update-transaction");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, "lease.json"), "{broken", { mode: 0o600 });
      await expect(assertNoUpdateTransaction(channel)).rejects.toThrow();
      await rm(directory, { recursive: true });
      const plan = join(channel, ".electrobun-update-0123456789abcdef0123456789abcdef.json");
      await writeFile(plan, "{}\n", { mode: 0o600 });
      await expect(assertNoUpdateTransaction(channel)).rejects.toThrow();
      await rm(plan);
      await expect(assertNoUpdateTransaction(channel)).resolves.toBeUndefined();
    } finally {
      lease?.releaseGuard();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("private failure evidence identifies the last attempted verification boundary", async () => {
  const source = patchEntrypoint(await readFile(resolve("src/main/index.ts"), "utf8"), true);
  for (const [stage, operation] of [
    ["failure-state", "if (updates.statusValue().readyVersion"],
    ["failure-renderer", "const responsive = await inspectViewport();"],
    ["failure-mcp", "const aliveReply = await modernCall("],
    ["failure-record", "await record({ phase: scenario"],
  ]) {
    const marker = `stage = "${stage}";`;
    expect(source.split(marker)).toHaveLength(2);
    expect(source.indexOf(marker)).toBeLessThan(source.indexOf(operation));
  }
  expect(source).toContain('phase: "failed", stage, rendererResult');
});

test("private failure cases require the intended HTTP fault and persisted partial bytes", () => {
  const manifest = "/releases/latest/download/stable-macos-arm64-update.json";
  const archive = "/releases/latest/download/stable-macos-arm64-MCPGateway.app.tar.zst";
  expect(() => assertFailurePrerequisites("offline", [], null)).toThrow();
  expect(() =>
    assertFailurePrerequisites("offline", [{ path: manifest, status: 200 }], null),
  ).toThrow();
  expect(() =>
    assertFailurePrerequisites("offline", [{ path: manifest, status: 503 }], null),
  ).not.toThrow();
  for (const partial of [
    null,
    { bytes: 0, expectedBytes: 100 },
    { bytes: 100, expectedBytes: 100 },
  ])
    expect(() =>
      assertFailurePrerequisites("interrupted", [{ path: archive, status: 200 }], partial),
    ).toThrow();
  expect(() =>
    assertFailurePrerequisites("interrupted", [], { bytes: 1, expectedBytes: 100 }),
  ).toThrow();
  expect(() =>
    assertFailurePrerequisites("interrupted", [{ path: archive, status: 200 }], {
      bytes: 1,
      expectedBytes: 100,
    }),
  ).not.toThrow();
});

test("invalid fixture source destination is refused before directory creation", async () => {
  const invalid = resolve("fixture-output-must-remain-absent");
  await expect(assertFixtureBase(invalid)).rejects.toThrow();
  await expect(installHooks(resolve("."), true)).rejects.toThrow();
  expect(await Bun.file(join(invalid, "package.json")).exists()).toBe(false);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "prepare-fixture-apps.ts")], {
    env: { PATH: process.env.PATH, MCP_GATEWAY_FIXTURE_BUILD_ROOT: invalid },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  await stderr;
  expect(
    await import("node:fs/promises").then((fs) =>
      fs.lstat(invalid).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ),
    ),
  ).toBe(false);
});

test("the opt-in product driver refuses an existing run directory without starting a fixture", async () => {
  const root = await mkdtemp(resolve(".cache/acceptance-existing-"));
  try {
    await writeFile(join(root, "sentinel"), "retained");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "product-update-flow.ts")], {
      env: { PATH: process.env.PATH, MCP_GATEWAY_ACCEPTANCE_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Product fixture setup failed");
    expect(stderr).not.toContain("DEBUG ERROR");
    expect(await readdir(root)).toEqual(["sentinel"]);
    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("retained");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture paths reject traversal and symlinked directories before writes or process inspection", async () => {
  const root = await mkdtemp(resolve(".cache/acceptance-paths-"));
  try {
    const target = join(root, "target");
    const link = join(root, "linked");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "sentinel"), "unchanged");
    await symlink(target, link);
    for (const path of [
      link,
      join(link, "missing"),
      join(resolve(".cache"), "../fixture-output-must-remain-absent"),
    ]) {
      await expect(assertFixtureBase(path)).rejects.toThrow();
      await expect(installHooks(path, true)).rejects.toThrow();
      await expect(inspectApp(path)).rejects.toThrow();
      await expect(stopApp(path)).rejects.toThrow();
    }
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("unchanged");
    expect(await Bun.file(join(target, "scripts/private-update-environment.ts")).exists()).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest(
  "cancelled parent cleanup joins an unlinked native helper and its subsequent launch before app cleanup",
  async () => {
    const root = await mkdtemp(resolve(".cache/acceptance-helper-"));
    const helper = join(root, "helper");
    const plan = join(root, "plan.json");
    const ready = join(root, "ready");
    let child: ReturnType<typeof spawnOwned> | undefined;
    try {
      const compiled = await runCommand(
        "/usr/bin/xcrun",
        ["clang", resolve("tests/fixtures/unlinked-helper.c"), "-o", helper],
        30_000,
      );
      expect(compiled.exitCode).toBe(0);
      await writeFile(plan, "{}\n");
      child = spawnOwned([helper, "--apply-update", plan, "--quiet"], root, {
        PATH: "/usr/bin:/bin",
        HELPER_READY: ready,
      });
      const deadline = Date.now() + 3000;
      while (!(await Bun.file(ready).exists())) {
        if (Date.now() > deadline) throw new Error("Helper did not start");
        await Bun.sleep(20);
      }
      let launched = false;
      let settled = false;
      const pending = waitForFixtureHelper(helper, plan, async () => launched, 10_000).then(() => {
        settled = true;
      });
      await Bun.sleep(150);
      expect(settled).toBe(false);
      child.child.kill("SIGKILL");
      await child.child.exited;
      await rm(plan);
      await Bun.sleep(150);
      expect(settled).toBe(false);
      launched = true;
      await pending;
      expect(settled).toBe(true);
    } finally {
      await child?.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("private fixture hooks patch current sources and remain outside production", async () => {
  const source = await readFile(resolve("src/main/index.ts"), "utf8");
  const root = await mkdtemp(resolve(".cache/update-hooks-test-"));
  try {
    for (const enabled of [false, true]) {
      const destination = join(root, String(enabled));
      await mkdir(join(destination, "scripts"), { recursive: true });
      await cp(resolve("src"), join(destination, "src"), { recursive: true });
      await cp(
        resolve("scripts/update-acceptance.ts"),
        join(destination, "scripts/update-acceptance.ts"),
      );
      await installHooks(destination, enabled);
      const patched = await readFile(join(destination, "src/main/index.ts"), "utf8");
      expect(patched).toStartWith('import "../../scripts/private-update-environment";');
      expect(patched).toContain(
        "await updates.completeInitialization();\nawait writeFixtureLaunchMarker();",
      );
      expect(patched).toContain('join(dataDirectory, "fixture-startups.jsonl")');
      expect(patched).not.toContain('join(PATHS.RESOURCES_FOLDER, "relaunch-marker")');
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      for (const file of [
        "src/main/index.ts",
        "src/shared/rpc.ts",
        "src/mainview/client.ts",
        "scripts/private-update-environment.ts",
      ]) {
        const text = await readFile(join(destination, file), "utf8");
        expect(() => transpiler.transformSync(text)).not.toThrow();
      }
      if (enabled) {
        expect(patched).toContain("rendererResult = await requestFixtureRestart();");
        expect(patched).toContain(
          "rpc.request.fixtureRestart(undefined, { maxRequestTime: 15_000 })",
        );
        expect(patched).toContain("await fixtureTriggerRecorded");
        expect(patched).toContain(
          'await recordPreHandoff(join(dataDirectory, "fixture-pre-handoff.jsonl"), {',
        );
        expect(patched).toContain(
          "attemptId: attempt.id, authoritativeAttemptId: updates.statusValue().attemptId ?? 0",
        );
        expect(patched.indexOf("await recordPreHandoff(")).toBeLessThan(
          patched.indexOf("const outcome = await applyVerifiedUpdate(attempt, session, sdk);"),
        );
      }
      const environment = await readFile(
        join(destination, "scripts/private-update-environment.ts"),
        "utf8",
      );
      expect(environment).toContain(join(fixtureRunRoot(), "home"));
      expect(environment).toContain(`"MCP_GATEWAY_UPDATE_ACCEPTANCE":"${enabled ? "1" : "0"}"`);
      const config = join(destination, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          extends: resolve("tsconfig.json"),
          include: ["src", "scripts"],
          exclude: [],
        }),
      );
      const checked = await runCommand(
        process.execPath,
        [resolve("node_modules/typescript/bin/tsc"), "--project", config],
        60_000,
      );
      expect(checked.stdout + checked.stderr).toBe("");
      expect(checked.exitCode).toBe(0);
    }
    expect(await readFile(resolve("src/main/index.ts"), "utf8")).toBe(source);
    expect(() =>
      patchEntrypoint(source.replace("await updates.completeInitialization();", ""), true),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("the standalone builder creates complete typecheckable projects without an old acceptance cache", async () => {
  const root = await mkdtemp(resolve(".cache/acceptance-checkout-"));
  try {
    for (const directory of ["src", "scripts", "assets", "tests", ".hutch"])
      await cp(resolve(directory), join(root, directory), { recursive: true });
    for (const file of [
      "package.json",
      "bun.lock",
      "tsconfig.json",
      "electrobun.config.ts",
      "hutch.config.ts",
      "vite.config.ts",
    ])
      await cp(resolve(file), join(root, file));
    await symlink(resolve("node_modules"), join(root, "node_modules"));
    await mkdir(join(root, ".hutch-home"));
    await mkdir(join(root, ".cache/research"), { recursive: true });
    await mkdir(join(root, ".cache/runtime-deps"));
    // Copy-only placeholders are never built; type checking uses the real prepared SDK.
    for (const file of [
      "electrobun-core-darwin-arm64.tar.gz",
      "cottontail-0.7.3.tar.gz",
      "bun-darwin-aarch64-1.4.4.zip",
    ])
      await writeFile(join(root, ".cache/research", file), "source-copy fixture only");
    const child = Bun.spawn(
      [process.execPath, join(root, "tests/native/update-acceptance/prepare-fixture-apps.ts")],
      {
        cwd: root,
        env: { PATH: process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 30_000);
    let report: { base: string; runRoot: string };
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      report = JSON.parse(stdout);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
    expect(report.base).toBe(join(root, ".cache/update-acceptance/fixture-apps"));
    expect(report.runRoot).toBe(join(root, ".cache/update-acceptance/product-update-flow"));
    expect(await readdir(join(root, ".cache"))).not.toContain("auto-update-0.3.1");
    for (const [name, version] of [
      ["a", FIXTURE_VERSIONS.initial],
      ["b", FIXTURE_VERSIONS.target],
    ]) {
      const destination = join(report.base, name);
      expect(JSON.parse(await readFile(join(destination, "package.json"), "utf8")).version).toBe(
        version,
      );
      expect(await readFile(join(destination, "tests/core/helpers.ts"), "utf8")).toBe(
        await readFile(resolve("tests/core/helpers.ts"), "utf8"),
      );
      const checked = await runCommand(
        process.execPath,
        [
          resolve("node_modules/typescript/bin/tsc"),
          "--project",
          join(destination, "tsconfig.json"),
        ],
        60_000,
      );
      expect(checked.stdout + checked.stderr).toBe("");
      expect(checked.exitCode).toBe(0);
      const entries = await readdir(destination);
      expect(entries).not.toContain("build");
      expect(entries).not.toContain("artifacts");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

nativeTest(
  "native fixture cleanup terminates only the copied executable",
  async () => {
    const root = await mkdtemp(resolve(".cache/update-process-test-"));
    const app = join(root, "Fixture.app");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    const executable = join(app, "Contents/MacOS/launcher");
    await cp(process.execPath, executable);
    const child = spawnOwned([executable, "-e", "setInterval(() => {}, 1000)"], root, {
      PATH: "/usr/bin:/bin",
      HOME: root,
      TMPDIR: root,
    });
    const output = new Response(child.child.stdout).text();
    const errors = new Response(child.child.stderr).text();
    try {
      expect((await inspectApp(app)).has(child.child.pid)).toBe(true);
      await stopApp(app);
      expect((await inspectApp(app)).size).toBe(0);
    } finally {
      await child.stop();
      await Promise.all([output, errors]);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("fixture process cleanup accepts exact executable paths and owner only", () => {
  const app = "/fixture/Applications/MCP Gateway.app";
  const row = (pid: number, uid: number, path: string) =>
    `${pid} ${uid} S Tue Nov 3 12:34:56 2026 ${path}\n`;
  const output =
    row(100, 501, join(app, "Contents/MacOS/launcher")) +
    row(101, 501, join(app, "Contents/MacOS/bun")) +
    row(102, 501, join(`${app}.backup`, "Contents/MacOS/launcher")) +
    row(103, 999, join(app, "Contents/MacOS/launcher")) +
    row(104, 501, `/usr/bin/tool ${app}`);
  expect([...fixtureProcesses(output, app, 501).keys()]).toEqual([100, 101]);
  expect(() => fixtureProcesses("unparseable", app, 501)).toThrow();
});
