import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { inventoryBundle } from "../../scripts/release-inventory";
import {
  PREPARED_UPDATE_FILE,
  UPDATER_ARTIFACT_FILE,
  UPDATER_IDENTIFIER,
} from "../../src/main/updater/constants";
import { cleanupInterruptedStaging, runOwnedWorker } from "../../src/main/updater/process";
import {
  captureRegisteredGroup,
  inspectRegisteredGroup,
  type RegisteredGroup,
} from "../../src/main/updater/registered-group";
import { runCommand } from "../../src/main/updater/verify";
import { eventually } from "../core/helpers";
import { appEntries, tarBytes, versionJson } from "../fixtures/updater";

const PROJECT = resolve(import.meta.dir, "../..");
const SDK = join(PROJECT, ".hutch/devkit/api/sdks/main/core/Updater.ts");
const SDK_SHA256 = "776f1c1e71fba8e0ba129c7c7a8961041ec6c74076740cb0cfca5b2e176b3544";
const CORE_SHA256 = "610db158df864a067055be365e443d3945392012f92092fb77c26bd2215ef892";
const PREFIX = "/zaherg/mcp-gateway/releases/latest/download/";
const MANIFEST = `${PREFIX}stable-macos-arm64-update.json`;
const ARTIFACT = `${PREFIX}${UPDATER_ARTIFACT_FILE}`;
const PATCH = `${PREFIX}stable-macos-arm64-current1234.patch`;
const NEXT_PATCH = `${PREFIX}stable-macos-arm64-middle1234.patch`;
const TARGET_HASH = "target123456";
const FILES = [
  "bun",
  "bspatch",
  "zig-zstd",
  "libElectrobunCore.dylib",
  "libNativeWrapper.dylib",
  "libasar.dylib",
];
let root: string;
let bin: string;
let bsdiff: string;
let currentTar: Uint8Array;
let targetTar: Uint8Array;
let targetZstd: Uint8Array;
const patches = new Map<string, Uint8Array>();
const provenance: Record<string, string> = {};
const evidence: Record<string, unknown>[] = [];
let cleanupConfirmed = true;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function checked(command: string, args: string[]) {
  const result = await runCommand(command, args, 30_000);
  expect(result.exitCode, `Command failed: ${command}`).toBe(0);
  return result.stdout.trim();
}

beforeAll(async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("SDK contract acceptance requires macOS arm64");
  const input = process.env.MCP_GATEWAY_SIGNED_PAYLOAD;
  if (!input) throw new Error("Set MCP_GATEWAY_SIGNED_PAYLOAD to a signed project-local app");
  const app = await realpath(input);
  if (!app.startsWith(`${await realpath(PROJECT)}/`) || !app.endsWith(".app"))
    throw new Error("The SDK contract input must be a project-local app");
  expect(digest(await readFile(SDK))).toBe(SDK_SHA256);
  expect(
    digest(await readFile(join(PROJECT, ".cache/research/electrobun-core-darwin-arm64.tar.gz"))),
  ).toBe(CORE_SHA256);
  await checked("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  expect(
    await checked("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      join(app, "Contents/Info.plist"),
    ]),
  ).toBe(UPDATER_IDENTIFIER);
  root = await mkdtemp(join(PROJECT, ".cache/updater-sdk-contract-"));
  // A regression in veto handling must never point a native apply plan outside this fixture.
  bin = join(root, "runtime/SDK Fixture.app/Contents/MacOS");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const name of FILES) {
    const source = join(app, "Contents/MacOS", name);
    await checked("/usr/bin/codesign", ["--verify", "--strict", source]);
    provenance[name] = digest(await readFile(source));
    await copyFile(source, join(bin, name));
  }
  if (process.env.MCP_GATEWAY_TEST_DISABLE_BSPATCH === "1")
    await chmod(join(bin, "bspatch"), 0o600);
  // Extract the patch generator from the verified official core, never a system substitute.
  const core = join(root, "core");
  await mkdir(core);
  await checked("/usr/bin/tar", [
    "-xzf",
    join(PROJECT, ".cache/research/electrobun-core-darwin-arm64.tar.gz"),
    "-C",
    core,
    "bsdiff",
  ]);
  bsdiff = join(core, "bsdiff");
  provenance.bsdiff = digest(await readFile(bsdiff));
  const current = appEntries({ version: "0.3.0", hash: "current1234" });
  currentTar = tarBytes(current);
  const middleTar = tarBytes(appEntries({ version: "0.3.1", hash: "middle1234" }));
  targetTar = tarBytes(appEntries({ version: "0.3.2", hash: TARGET_HASH }));
  for (const [name, bytes] of [
    ["current", currentTar],
    ["middle", middleTar],
    ["target", targetTar],
  ] as const)
    await writeFile(join(root, `${name}.tar`), bytes);
  await checked(join(bin, "zig-zstd"), [
    "compress",
    "-i",
    join(root, "target.tar"),
    "-o",
    join(root, "target.tar.zst"),
    "--no-timing",
  ]);
  targetZstd = await readFile(join(root, "target.tar.zst"));
  for (const [from, to] of [
    ["current", "target"],
    ["current", "middle"],
    ["middle", "target"],
    ["middle", "current"],
  ]) {
    const name = `${from}-${to}`;
    const path = join(root, `${name}.patch`);
    await checked(bsdiff, [join(root, `${from}.tar`), join(root, `${to}.tar`), path]);
    patches.set(name, await readFile(path));
  }
}, 60_000);

afterAll(async () => {
  if (!root) return;
  expect(digest(await readFile(SDK))).toBe(SDK_SHA256);
  for (const name of FILES) expect(digest(await readFile(join(bin, name)))).toBe(provenance[name]);
  await writeFile(
    join(root, "evidence.json"),
    `${JSON.stringify({ sdkSha256: SDK_SHA256, coreSha256: CORE_SHA256, provenance, cleanupConfirmed, cases: evidence }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (cleanupConfirmed) await rm(join(root, "runtime"), { recursive: true });
  console.log(`SDK contract evidence: ${join(root, "evidence.json")}`);
  expect(cleanupConfirmed).toBe(true);
});

async function stopFeed(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections();
  });
}

interface Scenario {
  name: string;
  patch?: "single" | "multi" | "missing" | "corrupt" | "cycle" | "interrupted";
  mode?: "prepare" | "api" | "veto" | "not-ready" | "sdk-dev";
  fault?:
    | "manifest-http"
    | "manifest-invalid"
    | "identity"
    | "channel"
    | "arch"
    | "fallback-http"
    | "artifact-missing"
    | "corrupt-archive"
    | "truncated-archive"
    | "offline"
    | "timeout"
    | "cancel";
  local?: "dev" | "missing";
  version?: string;
  hash?: string;
  cached?: "matching" | "stale";
  expected: "ready" | "failed" | "no-update" | "unavailable" | "cancelled";
}

async function runScenario(scenario: Scenario) {
  const directory = await mkdtemp(join(root, `${scenario.name}-`));
  const home = join(directory, "home");
  const channel = join(home, "Library/Application Support", UPDATER_IDENTIFIER, "stable");
  const staging = join(channel, "self-extraction");
  const resultPath = join(directory, "worker-result.json");
  const data = join(directory, "data");
  for (const path of [
    staging,
    data,
    join(directory, "tmp"),
    join(directory, "Resources"),
    join(directory, "MacOS"),
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const configuration = Buffer.from('{"synthetic":true}\n');
  await writeFile(join(data, "mcp.json"), configuration);
  await writeFile(join(data, "updates.json"), '{"automaticUpdates":false}\n');
  const preferences = await readFile(join(data, "updates.json"));
  if (scenario.local !== "missing") {
    const local = JSON.parse(versionJson("0.3.0", "current1234"));
    if (scenario.local === "dev") local.channel = "dev";
    await writeFile(join(directory, "Resources/version.json"), JSON.stringify(local));
  }
  const installedInventory = await inventoryBundle(join(directory, "Resources"));
  if (scenario.patch) await writeFile(join(staging, "current1234.tar"), currentTar);
  if (scenario.cached) {
    const cachedHash = scenario.cached === "matching" ? TARGET_HASH : "stale123456";
    const cachedVersion = scenario.cached === "matching" ? "0.3.2" : "0.3.0";
    await writeFile(
      join(staging, `${cachedHash}.tar`),
      scenario.cached === "matching" ? targetTar : currentTar,
    );
    await writeFile(
      join(staging, PREPARED_UPDATE_FILE),
      JSON.stringify({
        schema_version: 1,
        identifier: UPDATER_IDENTIFIER,
        channel: "stable",
        platform: "macos",
        arch: "arm64",
        version: cachedVersion,
        hash: cachedHash,
        artifact_file: UPDATER_ARTIFACT_FILE,
        retained_tar_path: join(staging, `${cachedHash}.tar`),
      }),
    );
  }
  const requests: Array<{ path: string; search: string }> = [];
  const manifest = {
    schemaVersion: 1,
    identifier: UPDATER_IDENTIFIER,
    channel: "stable",
    platform: "macos",
    arch: "arm64",
    version: scenario.version ?? "0.3.2",
    hash: scenario.hash ?? TARGET_HASH,
    artifact: { file: UPDATER_ARTIFACT_FILE },
  };
  if (scenario.fault === "identity") manifest.identifier = "invalid.identity";
  if (scenario.fault === "channel") manifest.channel = "canary";
  if (scenario.fault === "arch") manifest.arch = "x64";
  const cancellation = new AbortController();
  let partialObserved = false;
  let streamObservation: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ path: url.pathname, search: url.search });
    if (scenario.fault === "offline") {
      response.destroy();
      return;
    }
    if (scenario.fault === "timeout") return;
    if (url.pathname === MANIFEST) {
      if (scenario.fault === "manifest-http") {
        response.writeHead(503).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(scenario.fault === "manifest-invalid" ? "{broken" : JSON.stringify(manifest));
    } else if (url.pathname === PATCH || url.pathname === NEXT_PATCH) {
      let patch: Uint8Array | undefined;
      if (url.pathname === PATCH) {
        if (scenario.patch === "single") patch = patches.get("current-target");
        if (["multi", "cycle", "interrupted"].includes(scenario.patch ?? ""))
          patch = patches.get("current-middle");
        if (scenario.patch === "corrupt") patch = Buffer.from("not a patch");
      } else if (scenario.patch === "multi") patch = patches.get("middle-target");
      else if (scenario.patch === "cycle") patch = patches.get("middle-current");
      else if (scenario.patch === "interrupted") {
        const complete = patches.get("middle-target");
        if (!complete) throw new Error("Missing intermediate patch fixture");
        response.setHeader("Content-Length", complete.byteLength);
        response.setHeader("Connection", "close");
        response.end(complete.subarray(0, Math.floor(complete.byteLength / 2)));
        return;
      }
      if (!patch) response.writeHead(404).end();
      else response.end(patch);
    } else if (url.pathname === ARTIFACT) {
      if (scenario.fault === "fallback-http" || scenario.fault === "artifact-missing") {
        response.writeHead(scenario.fault === "artifact-missing" ? 404 : 503).end();
        return;
      }
      if (scenario.fault === "cancel") {
        response.setHeader("Content-Length", targetZstd.byteLength);
        response.write(targetZstd.subarray(0, Math.floor(targetZstd.byteLength / 2)));
        streamObservation = eventually(async () => {
          const partial = (await readdir(staging)).find((name) =>
            name.endsWith(".tar.zst.partial"),
          );
          return !!partial && (await Bun.file(join(staging, partial)).size) > 0;
        }, 5_000).then(() => {
          partialObserved = true;
          cancellation.abort();
        });
        void streamObservation.catch(() => cancellation.abort());
        return;
      }
      response.end(
        scenario.fault === "corrupt-archive"
          ? Buffer.from("invalid zstd")
          : scenario.fault === "truncated-archive"
            ? targetZstd.subarray(0, 12)
            : targetZstd,
      );
    } else response.writeHead(404).end();
  });
  let group: RegisteredGroup | undefined;
  let pending: ReturnType<typeof runOwnedWorker> | undefined;
  let groupAbsent = false;
  const failures: unknown[] = [];
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    pending = runOwnedWorker({
      command: join(bin, "bun"),
      args: [join(PROJECT, "tests/fixtures/updater-sdk-contract.ts")],
      cwd: join(directory, "MacOS"),
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        TMPDIR: join(directory, "tmp"),
        SDK_CONTRACT_ROOT: directory,
        SDK_CONTRACT_ORIGIN: `http://127.0.0.1:${address.port}`,
        SDK_CONTRACT_MODE: scenario.mode ?? "prepare",
        MCP_GATEWAY_UPDATE_RESULT: resultPath,
        MCP_GATEWAY_UPDATE_CHANNEL_ROOT:
          scenario.mode === "sdk-dev"
            ? join(home, "Library/Application Support", UPDATER_IDENTIFIER, "dev")
            : channel,
        MCP_GATEWAY_UPDATE_GRANT: "1",
      },
      resultPath,
      requireGrant: true,
      deadlineMs: scenario.fault === "timeout" ? 40_000 : 20_000,
      fileSizeLimitBytes: 1024 * 1024,
      signal: cancellation.signal,
      onRegistered: async (pid) => {
        group = await captureRegisteredGroup({
          leaderPid: pid,
          helperPath: join(bin, "bun"),
          planPath: resultPath,
        });
      },
    });
    const outcome = await pending;
    expect(outcome.closed).toBe(true);
    if (!group) throw new Error("SDK contract worker registration missing");
    const registered = group;
    await eventually(
      async () => (await inspectRegisteredGroup(registered)).status === "absent",
      3_000,
    );
    groupAbsent = true;
    await streamObservation;
    await stopFeed(server);
    const statuses = (await Bun.file(join(directory, "statuses.jsonl")).exists())
      ? (await readFile(join(directory, "statuses.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    const names = statuses.map((entry) => entry.status);
    const paths = requests.map((entry) => entry.path);
    if (scenario.expected === "cancelled") {
      expect(outcome.status).toBe("cancelled");
      expect(partialObserved).toBe(true);
      expect(names).not.toContain("download-complete");
    } else {
      expect(outcome.result?.status ?? JSON.parse(await readFile(resultPath, "utf8")).status).toBe(
        scenario.expected,
      );
      const contract = JSON.parse(await readFile(join(directory, "contract.json"), "utf8"));
      if (scenario.expected === "ready") {
        expect(outcome.status).toBe("completed");
        expect(contract.info).toMatchObject({ updateReady: true, error: "" });
        expect(digest(await readFile(join(staging, `${TARGET_HASH}.tar`)))).toBe(digest(targetTar));
        expect(
          JSON.parse(await readFile(join(staging, PREPARED_UPDATE_FILE), "utf8")),
        ).toMatchObject({ version: "0.3.2", hash: TARGET_HASH });
      } else if (scenario.expected === "failed") {
        expect(outcome.status).toBe("failed");
        expect(contract.info.updateReady).toBe(false);
        if (scenario.fault) expect(contract.info.error).not.toBe("");
      }
      if (scenario.mode === "api") expect(contract.historyAndUnsubscribe).toBe(true);
      if (scenario.mode === "veto") {
        expect(contract.vetoes).toBe(1);
        expect(contract.info.updateReady).toBe(true);
        expect(await Bun.file(join(staging, PREPARED_UPDATE_FILE)).exists()).toBe(true);
        expect(names).not.toContain("applying");
      }
    }
    if (scenario.patch === "single" || scenario.patch === "multi") {
      expect(paths).toEqual(
        scenario.patch === "single" ? [MANIFEST, PATCH] : [MANIFEST, PATCH, NEXT_PATCH],
      );
      expect(names.filter((name) => name === "applying-patch")).toHaveLength(
        scenario.patch === "single" ? 1 : 2,
      );
      expect(statuses.find((entry) => entry.status === "download-complete")?.details).toMatchObject(
        { usedPatchPath: true, totalPatchesApplied: scenario.patch === "single" ? 1 : 2 },
      );
      expect(paths).not.toContain(ARTIFACT);
    } else if (scenario.patch) {
      expect(paths).toContain(PATCH);
      expect(paths).toContain(ARTIFACT);
      if (scenario.patch === "cycle" || scenario.patch === "corrupt")
        expect(names).toContain("patch-failed");
      if (scenario.patch === "interrupted") {
        expect(paths).toContain(NEXT_PATCH);
        expect(names).toContain("patch-failed");
        expect(names.filter((name) => name === "patch-applied")).toHaveLength(1);
      }
    }
    if (scenario.fault) {
      const artifactFault = [
        "artifact-missing",
        "corrupt-archive",
        "truncated-archive",
        "cancel",
      ].includes(scenario.fault);
      expect(paths).toEqual(
        scenario.patch
          ? [MANIFEST, PATCH, ARTIFACT]
          : artifactFault
            ? [MANIFEST, ARTIFACT]
            : [MANIFEST],
      );
      if (scenario.fault !== "cancel") expect(names).toContain("error");
      if (scenario.fault === "corrupt-archive" || scenario.fault === "truncated-archive")
        expect(names).toContain("decompressing");
      expect(names).not.toContain("download-complete");
      expect(await Bun.file(join(staging, PREPARED_UPDATE_FILE)).exists()).toBe(false);
      expect(await Bun.file(join(staging, `${TARGET_HASH}.tar`)).exists()).toBe(false);
    }
    if (scenario.cached === "matching") expect(paths).toEqual([MANIFEST]);
    if (scenario.cached === "stale") expect(paths).toEqual([MANIFEST, ARTIFACT]);
    if (scenario.local) expect(paths).toEqual([]);
    if (scenario.hash === "current1234" || scenario.version) expect(paths).toEqual([MANIFEST]);
    for (const request of requests.filter(
      (entry) => entry.path === MANIFEST || entry.path === ARTIFACT,
    ))
      expect(request.search).not.toBe("");
    expect(
      (await readdir(channel)).filter((name) => name.startsWith(".electrobun-update-")),
    ).toEqual([]);
    expect(await inventoryBundle(join(directory, "Resources"))).toEqual(installedInventory);
    expect(await readFile(join(data, "mcp.json"))).toEqual(configuration);
    expect(await readFile(join(data, "updates.json"))).toEqual(preferences);
    if (scenario.patch)
      expect(digest(await readFile(join(staging, "current1234.tar")))).toBe(digest(currentTar));
    await cleanupInterruptedStaging({ channelRoot: channel, dataDirectory: data });
    expect(
      (await readdir(staging)).filter(
        (name) => name.endsWith(".partial") || name.endsWith(".patch"),
      ),
    ).toEqual([]);
    evidence.push({
      name: scenario.name,
      outcome,
      requests,
      statuses,
      partialObserved,
      unchangedMetadataAndConfiguration: true,
      workerGroupAbsent: true,
      targetTarSha256: scenario.expected === "ready" ? digest(targetTar) : null,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    cancellation.abort();
    for (const result of await Promise.allSettled([pending, stopFeed(server), streamObservation]))
      if (result.status === "rejected") failures.push(result.reason);
    if (group && !groupAbsent)
      groupAbsent = (await inspectRegisteredGroup(group)).status === "absent";
    if (pending && !groupAbsent) {
      cleanupConfirmed = false;
      failures.push(new Error("SDK contract worker ownership remains unresolved"));
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `SDK contract case failed: ${scenario.name}`);
}

const scenarios: Scenario[] = [
  { name: "fresh-full", expected: "ready" },
  { name: "prepared-reuse", cached: "matching", expected: "ready" },
  { name: "stale-prepared-refetch", cached: "stale", expected: "ready" },
  { name: "single-delta", patch: "single", expected: "ready" },
  { name: "multi-hop-delta", patch: "multi", expected: "ready" },
  { name: "missing-patch-fallback", patch: "missing", expected: "ready" },
  { name: "corrupt-patch-fallback", patch: "corrupt", expected: "ready" },
  { name: "cyclic-patch-fallback", patch: "cycle", expected: "ready" },
  { name: "interrupted-chain-fallback", patch: "interrupted", expected: "ready" },
  { name: "fallback-http-refusal", patch: "missing", fault: "fallback-http", expected: "failed" },
  { name: "metadata-history-single-flight", mode: "api", expected: "no-update" },
  { name: "actual-before-quit-veto", mode: "veto", expected: "no-update" },
  { name: "apply-without-preparation", mode: "not-ready", expected: "no-update" },
  { name: "packaged-dev-refusal", local: "dev", expected: "failed" },
  { name: "sdk-dev-discovery-disabled", mode: "sdk-dev", local: "dev", expected: "no-update" },
  { name: "missing-local-metadata", local: "missing", expected: "failed" },
  { name: "identical-hash", hash: "current1234", expected: "no-update" },
  { name: "same-version-new-hash", version: "0.3.0", expected: "no-update" },
  { name: "older-stable", version: "0.2.9", expected: "no-update" },
  { name: "prerelease", version: "0.3.2-beta.1", expected: "failed" },
  { name: "malformed-version", version: "not-a-version", expected: "failed" },
  ...(
    [
      "manifest-http",
      "manifest-invalid",
      "identity",
      "channel",
      "arch",
      "artifact-missing",
      "corrupt-archive",
      "truncated-archive",
      "offline",
      "timeout",
    ] as const
  ).map((fault): Scenario => ({ name: fault, fault, expected: "failed" })),
  { name: "cancel-partial-download", fault: "cancel", expected: "cancelled" },
];
for (const scenario of scenarios)
  test(`pinned SDK contract: ${scenario.name}`, () => runScenario(scenario), 50_000);
