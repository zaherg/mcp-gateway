import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { replaceOnce } from "../../../scripts/update-acceptance";
import { safeParent } from "../../../src/core/private-parent";
import { UPDATER_FEED_URL } from "../../../src/main/updater/constants";

export const FIXTURE_CACHE = resolve(".cache/update-acceptance");
export const FIXTURE_FEED = "http://127.0.0.1:47831/releases/latest/download";
export const FIXTURE_VERSIONS = { initial: "0.3.1", target: "0.3.2" } as const;

export function fixtureRunRoot(): string {
  return resolve(
    process.env.MCP_GATEWAY_ACCEPTANCE_ROOT ?? join(FIXTURE_CACHE, "product-update-flow"),
  );
}

const base = resolve(
  process.env.MCP_GATEWAY_FIXTURE_BUILD_ROOT ?? join(FIXTURE_CACHE, "fixture-apps"),
);

async function copyProject(destination: string, version: string) {
  await assertFixtureBase(destination);
  await mkdir(destination, { mode: 0o700 });
  for (const directory of ["src", "scripts", "assets", "tests"]) {
    await cp(resolve(directory), resolve(destination, directory), { recursive: true });
  }
  for (const file of [
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "electrobun.config.ts",
    "hutch.config.ts",
    "vite.config.ts",
  ]) {
    await cp(resolve(file), resolve(destination, file));
  }
  await cp(resolve(".hutch"), resolve(destination, ".hutch"), { recursive: true });
  for (const link of ["node_modules", ".hutch-home"]) {
    await symlink(resolve(link), resolve(destination, link));
  }
  await mkdir(resolve(destination, ".cache/research"), { recursive: true, mode: 0o700 });
  for (const file of [
    "electrobun-core-darwin-arm64.tar.gz",
    "cottontail-0.7.3.tar.gz",
    "bun-darwin-aarch64-1.4.4.zip",
  ])
    await cp(resolve(".cache/research", file), resolve(destination, ".cache/research", file));
  await cp(resolve(".cache/runtime-deps"), resolve(destination, ".cache/runtime-deps"), {
    recursive: true,
  });
  const packagePath = resolve(destination, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.version = version;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 4)}\n`);
  const constantsPath = resolve(destination, "src/main/updater/constants.ts");
  const constants = await readFile(constantsPath, "utf8");
  await writeFile(
    constantsPath,
    replaceOnce(
      constants,
      `export const UPDATER_FEED_URL = "${UPDATER_FEED_URL}";`,
      `export const UPDATER_FEED_URL = "${FIXTURE_FEED}";`,
    ),
  );
}

const markerCode = `
async function writeFixtureLaunchMarker(): Promise<void> {
  const document = await Bun.file(join(PATHS.RESOURCES_FOLDER, "version.json")).json();
  await recordCompletedStartup(join(dataDirectory, "fixture-startups.jsonl"), {
    version: document.version,
    hash: document.hash,
    dataDirectory,
    configPath: controller.snapshot().configPath,
    appBundlePath,
    home: homedir(),
    tmp: process.env.TMPDIR,
    pid: process.pid,
    transaction: updates.statusValue().transaction ?? null,
  }, async () => {
    if (!inspectViewport) throw new Error("Fixture renderer RPC unavailable");
    return inspectViewport();
  });
}
`;

const rendererRestartHandler = `
      fixtureRestart: async () => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const button = (text: string) => [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text);
        button("Settings")?.click();
        await sleep(350);
        const raw = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Authoritative configuration"));
        raw?.click();
        await sleep(350);
        const editor = document.querySelector<HTMLTextAreaElement>("textarea.code-editor");
        if (!editor || editor.readOnly) return "no-editor";
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (!setter) return "no-setter";
        setter.call(editor, editor.value + "\\n// fixture draft");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(350);
        const restart = button("Restart to Update");
        if (!restart || restart.disabled) return "no-restart";
        restart.click();
        await sleep(350);
        const confirm = button("Discard draft and restart");
        if (!confirm || confirm.disabled) return "no-confirm";
        confirm.click();
        return "clicked";
      },
`;

const acceptanceHook = `
  if (!isolated && process.env.MCP_GATEWAY_UPDATE_ACCEPTANCE === "1" &&
      !(await Bun.file(join(dataDirectory, "update-acceptance.json")).exists()))
    setTimeout(() => void runUpdateAcceptance(), 1_000);
`;

const acceptanceFunction = `
let acceptanceMcpClient: { close(): Promise<void> } | undefined;
let fixtureCleanupFailed = false;
let fixtureReadinessDelay: Promise<void> | undefined;
async function fixtureCase(): Promise<string> {
  const file = Bun.file(join(dataDirectory, "acceptance-case.json"));
  return await file.exists() ? (await file.json()).scenario : "success";
}

async function fixturePartialDownload(): Promise<{ path: string; bytes: number; expectedBytes: number } | null> {
  const started = Bun.file(join(dataDirectory, "download-started"));
  if (!(await started.exists())) return null;
  const expected = await started.json();
  const root = join(Utils.paths.appData, UPDATER_IDENTIFIER, UPDATER_CHANNEL, "self-extraction");
  for (const name of await readdir(root)) {
    if (!/^\\.[a-z0-9]+\\.[a-f0-9]{32}\\.tar\\.zst\\.partial$/.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size < expected.bytes)
      return { path, bytes: info.size, expectedBytes: expected.bytes };
  }
  return null;
}

async function runUpdateAcceptance(): Promise<void> {
  let stage = "mcp";
  let rendererResult: string | null = null;
  const record = async (value: Record<string, unknown>) => {
    const path = join(dataDirectory, "update-acceptance.json");
    await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
    await rename(path + ".tmp", path);
  };
  try {
    if (!controller.snapshot().running) await controller.start();
    const gateway = controller.snapshot();
    const config = parseConfig(gateway.configText, process.env, gateway.configFormat);
    const endpoint = new URL(\`http://127.0.0.1:\${config.gateway.port}/mcp/echo\`);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "update-acceptance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: \`Bearer \${config.gateway.token}\` } },
    });
    await client.connect(transport);
    const reply = await client.callTool({
      name: "echo",
      arguments: { value: "synthetic-update-activity" },
    });
    acceptanceMcpClient = client;
    const content = reply.content as Array<{ text?: string }>;
    const syntheticPid = JSON.parse(content[0]?.text ?? "{}").pid;
    if (!Number.isSafeInteger(syntheticPid) || syntheticPid <= 1)
      throw new Error("Synthetic MCP process identity missing");
    stage = "waiting-for-update";
    const scenario = await fixtureCase();
    if (scenario === "offline" || scenario === "interrupted") {
      const expected = scenario === "offline" ? "error" : "downloading";
      const deadline = Date.now() + 90_000;
      let partialDownload: Awaited<ReturnType<typeof fixturePartialDownload>> = null;
      while (updates.statusValue().phase !== expected ||
        (scenario === "interrupted" && !(partialDownload = await fixturePartialDownload()))) {
        if (Date.now() >= deadline) throw new Error("Failure-case state deadline");
        await Bun.sleep(100);
      }
      stage = "failure-state";
      if (updates.statusValue().readyVersion !== null || !inspectViewport)
        throw new Error("Failure case unexpectedly prepared or lost renderer");
      stage = "failure-renderer";
      const responsive = await inspectViewport();
      if (responsive.supported !== true) throw new Error("Failure-case renderer unresponsive");
      stage = "failure-mcp";
      const aliveReply = await client.callTool({ name: "echo", arguments: { value: "during-download-failure" } });
      if (aliveReply.isError) throw new Error("Failure case broke MCP session");
      stage = "failure-record";
      await record({ phase: scenario, syntheticPid, readyVersion: null, responsive: true, mcpUsable: true, partialDownload });
      quit?.armQuit(); Utils.quit();
      return;
    }
    const deadline = Date.now() + 90_000;
    while (updates.statusValue().phase !== "ready") {
      if (updates.statusValue().phase === "error")
        throw new Error(updates.statusValue().error ?? "update check failed");
      if (Date.now() >= deadline) throw new Error("update readiness timed out");
      await Bun.sleep(250);
    }
    openWindow();
    const windowDeadline = Date.now() + 15_000;
    while (!windowReady || !window) {
      if (Date.now() >= windowDeadline) throw new Error("window did not become ready");
      await Bun.sleep(100);
    }
    await Bun.sleep(1_500);
    if (!requestFixtureRestart) throw new Error("Fixture restart RPC unavailable");
    stage = "renderer-confirmation";
    rendererResult = await requestFixtureRestart();
    if (rendererResult !== "clicked") throw new Error("Fixture restart confirmation failed");
    await record({
      phase: "triggered",
      rendererResult,
      mcpReply: reply,
      syntheticPid,
      readyVersion: updates.statusValue().readyVersion,
    });
    completeFixtureTrigger(true);
    if (scenario === "cleanup-failure") {
      const deadline = Date.now() + 15_000;
      while (quitStatus().phase !== "failed") {
        if (Date.now() >= deadline) throw new Error("Cleanup failure did not surface");
        await Bun.sleep(50);
      }
      const failed = updates.statusValue();
      if (failed.phase !== "error" || !failed.readyVersion || !failed.availableHash ||
          await Bun.file(join(dataDirectory, "fixture-pre-handoff.jsonl")).exists())
        throw new Error("Cleanup failure armed or lost retry preparation");
      await writeFile(join(dataDirectory, "cleanup-failure.json"), JSON.stringify({ failedBeforeHandoff: true, readyVersion: failed.readyVersion, quitPhase: quitStatus().phase }), { mode: 0o600 });
      const retry = await service.handlers.updatesRestart({ version: failed.readyVersion, hash: failed.availableHash });
      if (!retry.ok) throw new Error("Cleanup retry was refused");
    }
    await Bun.sleep(60_000);
    throw new Error("update acceptance did not quit within its window");
  } catch {
    completeFixtureTrigger(false);
    await record({
      phase: "failed", stage, rendererResult,
      update: updates.statusValue(), quit: quitStatus(),
      error: "Private update acceptance failed; no success recorded.",
    });
    await acceptanceMcpClient?.close();
    Utils.quit();
  }
}
`;

export function patchEntrypoint(original: string, withAcceptance: boolean): string {
  let source = replaceOnce(
    original,
    'import { writeFile } from "node:fs/promises";',
    'import { lstat, readdir, rename, writeFile } from "node:fs/promises";\nimport { recordCompletedStartup, recordPreHandoff } from "../../scripts/update-acceptance";',
  );
  source = replaceOnce(
    source,
    "const dataDirectory = configurationDirectory(platform, homedir(), process.env, Utils.paths.config);",
    "const dataDirectory = configurationDirectory(platform, homedir(), process.env, Utils.paths.config);\n" +
      markerCode,
  );
  source = replaceOnce(
    source,
    "await updates.completeInitialization();",
    "await updates.completeInitialization();\nawait writeFixtureLaunchMarker();",
  );
  if (withAcceptance) {
    source = replaceOnce(
      source,
      "let requestRendererQuit:",
      `let requestFixtureRestart: (() => Promise<string>) | undefined;
let completeFixtureTrigger!: (accepted: boolean) => void;
const fixtureTriggerRecorded = new Promise<boolean>((resolve) => { completeFixtureTrigger = resolve; });
let requestRendererQuit:`,
    );
    source = replaceOnce(
      source,
      "  requestRendererQuit = () => rpc.request.smokeQuit();",
      "  requestRendererQuit = () => rpc.request.smokeQuit();\n  requestFixtureRestart = () => rpc.request.fixtureRestart(undefined, { maxRequestTime: 15_000 });",
    );
    source = replaceOnce(
      source,
      "        snapshot: async (input: unknown) => {",
      '        snapshot: async (input: unknown) => {\n          if (await fixtureCase() === "late-start") await (fixtureReadinessDelay ??= (async () => { const started = Date.now(); await Bun.sleep(6_000); await writeFile(join(dataDirectory, "readiness-delay.json"), JSON.stringify({ elapsedMs: Date.now() - started }), { mode: 0o600 }); })());',
    );
    source = replaceOnce(
      source,
      "        ...service.handlers,",
      `        ...service.handlers,
        updatesRestart: async (input: unknown) => {
          if (!(await fixtureTriggerRecorded)) throw new Error("Fixture trigger refused");
          return service.handlers.updatesRestart(input);
        },`,
    );
    source = replaceOnce(
      source,
      "await writeFixtureLaunchMarker();",
      `await writeFixtureLaunchMarker();\n${acceptanceHook}`,
    );
    source = replaceOnce(
      source,
      "    await controller.close();",
      '    if (await fixtureCase() === "cleanup-failure" && !fixtureCleanupFailed) { fixtureCleanupFailed = true; throw new Error("Injected private cleanup failure"); }\n    await controller.close();',
    );
    source = replaceOnce(
      source,
      "      const outcome = await applyVerifiedUpdate(attempt, session, sdk);",
      `      const trigger = JSON.parse(await Bun.file(join(dataDirectory, "update-acceptance.json")).text());
      await recordPreHandoff(join(dataDirectory, "fixture-pre-handoff.jsonl"), {
        attemptId: attempt.id, authoritativeAttemptId: updates.statusValue().attemptId ?? 0,
        version: attempt.candidate.version, hash: attempt.candidate.hash, syntheticPid: trigger.syntheticPid,
      });
      const outcome = await applyVerifiedUpdate(attempt, session, sdk);`,
    );
    source += `\n${acceptanceFunction}\n`;
  }
  return `import "../../scripts/private-update-environment";\n${source}`;
}

export async function installHooks(destination: string, withAcceptance: boolean) {
  await assertFixtureBase(destination);
  const indexPath = resolve(destination, "src/main/index.ts");
  const runRoot = fixtureRunRoot();
  await assertFixtureBase(runRoot);
  for (const directory of ["scripts", "src/main", "src/shared", "src/mainview"])
    await assertFixtureBase(resolve(destination, directory));
  const home = resolve(runRoot, "home");
  const tmp = resolve(runRoot, "tmp");
  // Launch Services does not establish inheritance of the first launch's overrides.
  // These fixed roots exist only in private A/B bundles, before SDK imports run.
  await writeFile(
    resolve(destination, "scripts/private-update-environment.ts"),
    `Object.assign(process.env, ${JSON.stringify({
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      XDG_CONFIG_HOME: resolve(home, "config"),
      XDG_DATA_HOME: resolve(home, "data"),
      XDG_CACHE_HOME: resolve(home, "cache"),
      XDG_STATE_HOME: resolve(home, "state"),
      XDG_RUNTIME_DIR: resolve(runRoot, "runtime"),
      MCP_GATEWAY_DATA_DIR: resolve(runRoot, "data"),
      MCP_GATEWAY_UPDATE_ACCEPTANCE: withAcceptance ? "1" : "0",
    })});\ndelete process.env.MCP_GATEWAY_ISOLATED;\ndelete process.env.MCP_GATEWAY_SMOKE;\n`,
  );
  await writeFile(indexPath, patchEntrypoint(await readFile(indexPath, "utf8"), withAcceptance));
  if (withAcceptance) {
    const rpcPath = resolve(destination, "src/shared/rpc.ts");
    await writeFile(
      rpcPath,
      replaceOnce(
        await readFile(rpcPath, "utf8"),
        "      smokeQuit: { params: undefined; response: boolean };",
        "      smokeQuit: { params: undefined; response: boolean };\n      fixtureRestart: { params: undefined; response: string };",
      ),
    );
    const clientPath = resolve(destination, "src/mainview/client.ts");
    await writeFile(
      clientPath,
      replaceOnce(
        await readFile(clientPath, "utf8"),
        "      smokeQuit: () => {",
        `${rendererRestartHandler}\n      smokeQuit: () => {`,
      ),
    );
  }
}

export async function assertFixtureBase(path: string): Promise<void> {
  const directory = resolve(path);
  if (!directory.startsWith(resolve(".cache") + sep))
    throw new Error("Private fixture paths must remain project-local.");
  await safeParent(join(directory, ".fixture-check"), true);
}

if (import.meta.main) {
  await assertFixtureBase(base);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await copyProject(resolve(base, "a"), FIXTURE_VERSIONS.initial);
  await copyProject(resolve(base, "b"), FIXTURE_VERSIONS.target);
  await installHooks(resolve(base, "a"), true);
  await installHooks(resolve(base, "b"), false);
  console.log(JSON.stringify({ ok: true, base, feed: FIXTURE_FEED, runRoot: fixtureRunRoot() }));
}
