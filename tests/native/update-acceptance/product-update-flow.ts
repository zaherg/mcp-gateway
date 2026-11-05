import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeEnvironment, ownFixture, spawnOwned } from "../../../scripts/native-process";
import {
  compareBundleInventories,
  inventoryBundle,
  inventoryDigest,
} from "../../../scripts/release-inventory";
import { assertUpdateAcceptance, parseStartupMarkers } from "../../../scripts/update-acceptance";
import { readLease } from "../../../src/main/updater/transaction";
import { runCommand } from "../../../src/main/updater/verify";
import { freePort } from "../../../tests/core/helpers";
import {
  assertFixtureBase,
  FIXTURE_CACHE,
  FIXTURE_FEED,
  FIXTURE_VERSIONS,
  fixtureRunRoot,
} from "./prepare-fixture-apps";
import { settleProductHandoff } from "./settle-product-helper";

const CACHE = FIXTURE_CACHE;
const A_APP = resolve(
  process.env.MCP_GATEWAY_FIXTURE_A_APP ?? join(CACHE, "fixture-a-app/MCP Gateway.app"),
);
const B_ASSETS = resolve(
  process.env.MCP_GATEWAY_FIXTURE_B_ASSETS ?? join(CACHE, "fixture-b-assets"),
);
const OUT = fixtureRunRoot();
const SCENARIO = process.env.MCP_GATEWAY_ACCEPTANCE_CASE ?? "success";
const PORT = Number(new URL(FIXTURE_FEED).port);
const FEED = FIXTURE_FEED;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error("Product update flow timed out");
}
async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

// Launch Services can put the replacement in a different group. Match executable
// paths exactly, retain UID/start-time identity, and never signal substring matches.
export function fixtureProcesses(text: string, app: string, uid: number): Map<number, string> {
  const executables = new Set([
    join(app, "Contents/MacOS/launcher"),
    join(app, "Contents/MacOS/bun"),
  ]);
  const result = new Map<number, string>();
  for (const line of text.split("\n").filter((line) => line.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/.exec(
      line,
    );
    if (!match) throw new Error("Could not parse fixture process inspection.");
    if (Number(match[2]) === uid && !match[3]?.startsWith("Z") && executables.has(match[5] ?? ""))
      result.set(Number(match[1]), `${match[2]} ${match[4]} ${match[5]}`);
  }
  return result;
}
export async function inspectApp(app: string): Promise<Map<number, string>> {
  await assertFixtureBase(app);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Fixture process owner unavailable.");
  const executables = [join(app, "Contents/MacOS/launcher"), join(app, "Contents/MacOS/bun")].map(
    (path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const selected = await runCommand(
    "/usr/bin/pgrep",
    ["-U", String(uid), "-f", `^(${executables.join("|")})( |$)`],
    5_000,
  );
  if (selected.exitCode === 1 && selected.stdout.trim() === "") return new Map();
  if (selected.exitCode !== 0) throw new Error("Fixture process selection failed.");
  const pids = selected.stdout.trim().split(/\s+/);
  if (pids.length > 64 || pids.some((pid) => !/^[1-9][0-9]*$/.test(pid)))
    throw new Error("Fixture process selection was invalid or oversized.");
  const result = await runCommand(
    "/bin/ps",
    ["-ww", "-p", pids.join(","), "-o", "pid=,uid=,stat=,lstart=,comm="],
    5_000,
  );
  if (result.exitCode === 1 && result.stdout.trim() === "") return new Map();
  if (result.exitCode !== 0) throw new Error("Fixture process inspection failed.");
  return fixtureProcesses(result.stdout, app, uid);
}
export async function stopApp(app: string): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const owned = await inspectApp(app);
    for (const [pid, identity] of owned) {
      const current = (await inspectApp(app)).get(pid);
      if (current === undefined) continue;
      if (current !== identity || pid <= 1 || pid === process.pid)
        throw new Error("Fixture process identity changed before cleanup.");
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const deadline = Date.now() + (signal === "SIGTERM" ? 12_000 : 3_000);
    while ((await inspectApp(app)).size > 0 && Date.now() < deadline) await Bun.sleep(100);
    if ((await inspectApp(app)).size === 0) return;
  }
  throw new Error("Owned fixture application survived cleanup.");
}

export function assertFailurePrerequisites(
  scenario: string,
  responses: Array<{ path: string; status: number }>,
  partial: { bytes: number; expectedBytes: number } | null,
): void {
  const manifest = "/releases/latest/download/stable-macos-arm64-update.json";
  const archive = "/releases/latest/download/stable-macos-arm64-MCPGateway.app.tar.zst";
  if (
    scenario === "offline" &&
    !responses.some((entry) => entry.path === manifest && entry.status === 503)
  )
    throw new Error("Offline case did not receive its intended manifest failure.");
  if (
    scenario === "interrupted" &&
    (!responses.some((entry) => entry.path === archive && entry.status === 200) ||
      !partial ||
      !Number.isSafeInteger(partial.bytes) ||
      !Number.isSafeInteger(partial.expectedBytes) ||
      partial.bytes <= 0 ||
      partial.bytes >= partial.expectedBytes)
  )
    throw new Error("Interrupted case did not persist an incomplete SDK download.");
}

export async function assertNoUpdateTransaction(channel: string): Promise<void> {
  if (
    (await readLease(channel)) !== undefined ||
    (await readdir(channel)).some((name) => /^\.electrobun-update-/.test(name))
  )
    throw new Error("Failure case retained an active transaction or armed native plan.");
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Packaged update acceptance requires macOS arm64.");
  await Promise.all([A_APP, B_ASSETS, OUT].map(assertFixtureBase));
  if (!["success", "offline", "interrupted", "cleanup-failure", "late-start"].includes(SCENARIO))
    throw new Error("Invalid private acceptance scenario.");
  // Never delete a prior run's app, recovery evidence or possible live resources.
  await mkdir(OUT, { mode: 0o700 });
  const roots = {
    home: join(OUT, "home"),
    dataDirectory: join(OUT, "data"),
    tmp: join(OUT, "tmp"),
    appBundlePath: join(OUT, "home/Applications/MCP Gateway.app"),
    configPath: join(OUT, "data/mcp.json"),
  };
  await Promise.all([
    mkdir(join(roots.home, "Applications"), { recursive: true }),
    mkdir(roots.dataDirectory, { mode: 0o700 }),
    mkdir(roots.tmp, { mode: 0o700 }),
  ]);
  await cp(A_APP, roots.appBundlePath, { recursive: true, preserveTimestamps: true });
  const initialInventory = await inventoryBundle(roots.appBundlePath);
  const initial = JSON.parse(
    await readFile(join(A_APP, "Contents/Resources/version.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(join(B_ASSETS, "stable-macos-arm64-update.json"), "utf8"),
  );
  if (initial.version !== FIXTURE_VERSIONS.initial || manifest.version !== FIXTURE_VERSIONS.target)
    throw new Error("Fixture versions do not match.");
  const artifact = await readFile(join(B_ASSETS, "stable-macos-arm64-MCPGateway.app.tar.zst"));
  const fixture = resolve("tests/fixtures/stdio-mcp.ts");
  const pidFile = join(roots.dataDirectory, "fixture-pids");
  const config = {
    gateway: {
      host: "127.0.0.1",
      port: await freePort(),
      token: "product-update-token-0123456789abcdef",
      autoStart: true,
      launchAtLogin: false,
    },
    mcpServers: {
      echo: {
        command: process.execPath,
        args: [fixture, roots.dataDirectory],
        env: { PID_FILE: pidFile },
      },
    },
  };
  await writeFile(roots.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const configHash = digest(await readFile(roots.configPath));
  await writeFile(
    join(roots.dataDirectory, "acceptance-case.json"),
    JSON.stringify({ scenario: SCENARIO }),
    { mode: 0o600 },
  );
  const requests: string[] = [];
  const responses: Array<{ path: string; status: number }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      responses.push({ path, status: SCENARIO === "offline" ? 503 : 200 });
      if (SCENARIO === "offline") return new Response("synthetic outage", { status: 503 });
      if (path === "/releases/latest/download/stable-macos-arm64-update.json")
        return Response.json(manifest);
      if (path === "/releases/latest/download/stable-macos-arm64-MCPGateway.app.tar.zst") {
        if (SCENARIO === "interrupted") {
          await writeFile(
            join(roots.dataDirectory, "download-started"),
            JSON.stringify({ bytes: artifact.byteLength }),
            { mode: 0o600 },
          );
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(artifact.subarray(0, 1024));
              },
            }),
            { headers: { "content-length": String(artifact.byteLength) } },
          );
        }
        return new Response(artifact, {
          headers: { "content-length": String(artifact.byteLength) },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  let processHandle: ReturnType<typeof spawnOwned> | undefined;
  let stdout: Promise<string> = Promise.resolve("");
  let stderr: Promise<string> = Promise.resolve("");
  const evidence: Record<string, unknown> = {
    schemaVersion: 3,
    scenario: SCENARIO,
    initialRuntime: { version: initial.version, hash: initial.hash },
    initialInventoryDigest: inventoryDigest(initialInventory),
    configurationSha256: configHash,
    feed: FEED,
    requests,
    responses,
    ok: false,
  };
  const cancellation = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    cancellation.abort();
  };
  const terminate = () => {
    process.exitCode = 143;
    cancellation.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let stage = "initial-launch";
  try {
    const env = nativeEnvironment(OUT, "macos", { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    delete env.MCP_GATEWAY_ISOLATED;
    delete env.MCP_GATEWAY_SMOKE;
    env.MCP_GATEWAY_DATA_DIR = roots.dataDirectory;
    env.MCP_GATEWAY_UPDATE_ACCEPTANCE = "1";
    processHandle = spawnOwned(
      [join(roots.appBundlePath, "Contents/MacOS/launcher")],
      join(roots.appBundlePath, "Contents/MacOS"),
      env,
    );
    stdout = new Response(processHandle.child.stdout).text();
    stderr = new Response(processHandle.child.stderr).text();
    stage = "waiting-for-trigger";
    const trigger = await waitFor(
      async () => {
        const text = await optionalText(join(roots.dataDirectory, "update-acceptance.json"));
        return text === undefined ? undefined : JSON.parse(text);
      },
      120_000,
      cancellation.signal,
    );
    const failureCase = SCENARIO === "offline" || SCENARIO === "interrupted";
    if (trigger.phase !== (failureCase ? SCENARIO : "triggered"))
      throw new Error("Private update trigger failed.");
    stage = "waiting-for-old-exit";
    const oldProcessExit = await waitFor(
      async () => processHandle?.child.exitCode ?? undefined,
      90_000,
      cancellation.signal,
    );
    const markerPath = join(roots.dataDirectory, "fixture-startups.jsonl");
    if (failureCase) {
      assertFailurePrerequisites(SCENARIO, responses, trigger.partialDownload);
      compareBundleInventories(initialInventory, await inventoryBundle(roots.appBundlePath));
      if (SCENARIO === "interrupted") {
        const partial = trigger.partialDownload;
        const staging = join(
          roots.home,
          "Library/Application Support/dev.srvr.mcpgateway/stable/self-extraction",
        );
        if (
          typeof partial.path !== "string" ||
          !partial.path.startsWith(`${staging}/`) ||
          (await optionalText(partial.path)) !== undefined ||
          (await readdir(staging)).some((name) => name.endsWith(".partial"))
        )
          throw new Error("Interrupted SDK download was not cleaned.");
      }
      const startups = parseStartupMarkers(await readFile(markerPath, "utf8"));
      if (
        oldProcessExit !== 0 ||
        startups.length !== 1 ||
        startups[0]?.version !== initial.version ||
        startups[0]?.hash !== initial.hash ||
        trigger.readyVersion !== null ||
        trigger.responsive !== true ||
        trigger.mcpUsable !== true ||
        !Number.isSafeInteger(trigger.syntheticPid) ||
        trigger.syntheticPid <= 1 ||
        alive(trigger.syntheticPid) ||
        digest(await readFile(roots.configPath)) !== configHash ||
        (await optionalText(join(roots.dataDirectory, "fixture-pre-handoff.jsonl"))) !== undefined
      )
        throw new Error("Failure-case preservation or shutdown assertion failed.");
      const channel = join(roots.home, "Library/Application Support/dev.srvr.mcpgateway/stable");
      await assertNoUpdateTransaction(channel);
      const current = JSON.parse(
        await readFile(join(roots.appBundlePath, "Contents/Resources/version.json"), "utf8"),
      );
      if (current.version !== initial.version || current.hash !== initial.hash)
        throw new Error("Failure case replaced the application.");
      Object.assign(evidence, {
        trigger,
        startups,
        oldProcessExit,
        noHandoff: true,
        noTransaction: true,
        oldChildAlive: false,
        configByteIdentical: true,
        retainedVersion: current.version,
      });
    } else {
      stage = "waiting-for-target-startup";
      await waitFor(
        async () => {
          const text = await optionalText(markerPath);
          if (text === undefined) return undefined;
          return parseStartupMarkers(text).length >= 2 ? true : undefined;
        },
        45_000,
        cancellation.signal,
      );
      // Observe a bounded window for duplicate completed launches, then read all records again.
      await Bun.sleep(2_000);
      stage = "target-assertions";
      const startupText = await readFile(markerPath, "utf8");
      if (!Number.isSafeInteger(trigger.syntheticPid) || trigger.syntheticPid <= 1)
        throw new Error("Synthetic backend PID missing.");
      const oldChildAlive = alive(trigger.syntheticPid);
      const configByteIdentical = digest(await readFile(roots.configPath)) === configHash;
      const startups = assertUpdateAcceptance({
        preHandoffText: await readFile(
          join(roots.dataDirectory, "fixture-pre-handoff.jsonl"),
          "utf8",
        ),
        startupText,
        initial,
        target: manifest,
        roots,
        trigger,
        oldProcessExit,
        oldChildAlive,
        configByteIdentical,
      });
      if (!(await inspectApp(roots.appBundlePath)).has(startups[1].pid))
        throw new Error("Completed target startup is no longer running at the fixture path.");
      const current = JSON.parse(
        await readFile(join(roots.appBundlePath, "Contents/Resources/version.json"), "utf8"),
      );
      if (
        current.version !== manifest.version ||
        current.hash !== manifest.hash ||
        !requests.includes("/releases/latest/download/stable-macos-arm64-update.json") ||
        !requests.includes("/releases/latest/download/stable-macos-arm64-MCPGateway.app.tar.zst")
      )
        throw new Error("Target payload or feed evidence does not match.");
      Object.assign(evidence, {
        preHandoffText: await readFile(
          join(roots.dataDirectory, "fixture-pre-handoff.jsonl"),
          "utf8",
        ),
        startups,
        trigger,
        oldProcessExit,
        oldChildAlive,
        configByteIdentical,
        target: { version: current.version, hash: current.hash },
      });
      if (SCENARIO === "late-start") {
        const delayed = JSON.parse(
          await readFile(join(roots.dataDirectory, "readiness-delay.json"), "utf8"),
        );
        if (!Number.isSafeInteger(delayed.elapsedMs) || delayed.elapsedMs < 6_000)
          throw new Error("Renderer delay was not exercised.");
        evidence.delayedReadiness = delayed;
      }
      if (SCENARIO === "cleanup-failure") {
        const failure = JSON.parse(
          await readFile(join(roots.dataDirectory, "cleanup-failure.json"), "utf8"),
        );
        if (
          failure.failedBeforeHandoff !== true ||
          failure.quitPhase !== "failed" ||
          failure.readyVersion !== manifest.version
        )
          throw new Error("Cleanup-failure retry evidence is missing.");
        evidence.cleanupFailureRetry = failure;
      }
    }
    cancellation.signal.throwIfAborted();
    evidence.assertionsPassed = true;
  } catch {
    evidence.failedStage = stage;
    evidence.error = "Product update acceptance failed; inspect retained synthetic evidence.";
    process.exitCode ||= 1;
  } finally {
    server.stop(true);
    const failures: string[] = [];
    let parentStopped = false;
    let helperSettled = false;
    try {
      await processHandle?.stop();
      parentStopped = true;
    } catch {
      failures.push("Initial app group cleanup failed.");
    }
    if (parentStopped) {
      try {
        evidence.helperSettlement = await settleProductHandoff(roots, async () => {
          const text = await optionalText(join(roots.dataDirectory, "fixture-startups.jsonl"));
          return text !== undefined && parseStartupMarkers(text).length >= 2;
        });
        helperSettled = true;
      } catch {
        failures.push(
          "Native helper/launch settlement remains unconfirmed; retained private state.",
        );
      }
    }
    if (helperSettled) {
      try {
        await stopApp(roots.appBundlePath);
      } catch {
        failures.push("Replacement app cleanup failed.");
      }
    }
    try {
      const pids = await optionalText(pidFile);
      for (const line of pids?.trim().split("\n") ?? []) {
        await (await ownFixture(Number(line), fixture, roots.dataDirectory))?.stop();
      }
    } catch {
      failures.push("Synthetic backend cleanup failed.");
    }
    evidence.cleanup = {
      ok: failures.length === 0 && evidence.assertionsPassed === true,
      failures,
      nativeHelperConfirmedFinished: helperSettled,
      note: helperSettled
        ? null
        : "Native helper completion is unconfirmed; retain the run directory and journal for inspection.",
    };
    evidence.ok = evidence.assertionsPassed === true && failures.length === 0;
    if (!evidence.ok) process.exitCode ||= 1;
    if (failures.length === 0) {
      await writeFile(join(OUT, "app-stdout.log"), await stdout, { mode: 0o600 });
      await writeFile(join(OUT, "app-stderr.log"), await stderr, { mode: 0o600 });
    }
    await writeFile(join(OUT, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify({ ok: evidence.ok, evidence: join(OUT, "evidence.json") }));
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
if (import.meta.main) {
  await main().catch(() => {
    console.error(
      "Product fixture setup failed; check macOS arm64 prerequisites and inspect the retained run directory.",
    );
    process.exitCode = 1;
  });
}
