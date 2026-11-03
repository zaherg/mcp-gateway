import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
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
  UPDATER_CHANNEL,
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
const WORKER = join(PROJECT, "tests/fixtures/updater-real-sdk-worker.ts");
const SDK = join(PROJECT, ".hutch/devkit/api/sdks/main/core/Updater.ts");
// Official Electrobun 2.0.5 Updater.ts, not a generated fixture or vendor patch.
const SDK_SHA256 = "776f1c1e71fba8e0ba129c7c7a8961041ec6c74076740cb0cfca5b2e176b3544";
const BUNDLED_FILES = [
  "bun",
  "zig-zstd",
  "libElectrobunCore.dylib",
  "libNativeWrapper.dylib",
  "libasar.dylib",
];
const LIMIT = 64 * 1024;
const TARGET_HASH = "target123456";
const TARGET_VERSION = "0.3.1";
const MANIFEST_PATH = "/zaherg/mcp-gateway/releases/latest/download/stable-macos-arm64-update.json";
const ARTIFACT_PATH = `/zaherg/mcp-gateway/releases/latest/download/${UPDATER_ARTIFACT_FILE}`;
let root: string;
let bun: string;
let zstd: string;
let app: string;
const provenance: Record<string, string> = {};
const evidence: Record<string, unknown>[] = [];
let cleanupConfirmed = true;
const resolverEvidence: Record<string, unknown>[] = [];
const admissionEvidence: Record<string, unknown>[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function checked(command: string, args: string[]): Promise<string> {
  const result = await runCommand(command, args, 30_000);
  // Platform command diagnostics can include signing identities; never echo them.
  expect(result.exitCode, `Command failed: ${command}`).toBe(0);
  return result.stdout.trim();
}

beforeAll(async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("SDK storage acceptance requires macOS arm64; it must not silently skip");
  const input = process.env.MCP_GATEWAY_SDK_LIMIT_APP;
  if (!input)
    throw new Error(
      "Set MCP_GATEWAY_SDK_LIMIT_APP to a retained signed project-local payload .app",
    );
  app = await realpath(input);
  if (!app.startsWith(`${await realpath(PROJECT)}/`) || !app.endsWith(".app"))
    throw new Error("The signed payload must be inside this project");
  expect(
    JSON.parse(await readFile(join(PROJECT, "package.json"), "utf8")).devDependencies.electrobun,
  ).toBe("2.0.5");
  expect(sha256(await readFile(SDK))).toBe(SDK_SHA256);
  await checked("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  expect(
    await checked("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      join(app, "Contents/Info.plist"),
    ]),
  ).toBe(UPDATER_IDENTIFIER);
  await mkdir(join(PROJECT, ".cache"), { recursive: true });
  root = await mkdtemp(join(PROJECT, ".cache/updater-sdk-limits-"));
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  for (const name of BUNDLED_FILES) {
    const source = join(app, "Contents/MacOS", name);
    expect((await lstat(source)).isFile()).toBe(true);
    expect((await checked("/usr/bin/lipo", ["-archs", source])).split(/\s+/)).toContain("arm64");
    await checked("/usr/bin/codesign", ["--verify", "--strict", source]);
    provenance[name] = sha256(await readFile(source));
    await copyFile(source, join(bin, name));
    expect(sha256(await readFile(join(bin, name)))).toBe(provenance[name]);
  }
  bun = join(bin, "bun");
  zstd = join(bin, "zig-zstd");
}, 60_000);

afterAll(async () => {
  if (!root) return;
  expect(sha256(await readFile(SDK))).toBe(SDK_SHA256);
  for (const name of BUNDLED_FILES) {
    expect(sha256(await readFile(join(app, "Contents/MacOS", name)))).toBe(provenance[name]);
    expect(sha256(await readFile(join(root, "bin", name)))).toBe(provenance[name]);
  }
  const path = join(root, "evidence.json");
  await writeFile(
    path,
    `${JSON.stringify(
      {
        sdkVersion: "2.0.5",
        sdkSha256: SDK_SHA256,
        signedPayload: app,
        binaries: provenance,
        limitBytes: LIMIT,
        expectedCases: 7,
        completedCases: evidence.length,
        cases: evidence,
        resolverEvidence,
        admissionEvidence,
        scope:
          "Unchanged SDK and production owned worker with copied signed runtime/helper, synthetic loopback HTTP and small injected limits; no app launch, apply, new build or publication.",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  if (cleanupConfirmed) await rm(join(root, "bin"), { recursive: true });
  console.log(`SDK storage-limit evidence: ${path}`);
  expect(cleanupConfirmed).toBe(true);
  expect(evidence).toHaveLength(7);
  expect(admissionEvidence).toHaveLength(6);
});

function archive(bytes: number, incompressible = false): Uint8Array {
  const entry = { name: "MCP Gateway.app/Contents/Resources/padding", contents: new Uint8Array() };
  const overhead = tarBytes(appEntries({ extra: [entry] })).byteLength;
  const padding = bytes - overhead;
  if (padding < 0 || padding % 512 !== 0) throw new Error("Invalid fixture TAR size");
  entry.contents = incompressible ? randomBytes(padding) : new Uint8Array(padding);
  const tar = tarBytes(appEntries({ extra: [entry] }));
  expect(tar.byteLength).toBe(bytes);
  return tar;
}

async function stopFeed(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

interface CaseOptions {
  name: string;
  tar: Uint8Array;
  fileLimit: number;
  chunked?: boolean;
  gateNetworkAtLimit?: boolean;
  refusal?: "network" | "expansion";
  resolverProbe?: boolean;
  resolverControl?: boolean;
}

async function runCase(options: CaseOptions): Promise<void> {
  const directory = await mkdtemp(join(root, `${options.name}-`));
  const home = join(directory, "home");
  const channel = join(home, "Library/Application Support", UPDATER_IDENTIFIER, UPDATER_CHANNEL);
  const staging = join(channel, "self-extraction");
  const data = join(directory, "data");
  const resultPath = join(directory, "worker-result.json");
  const tarPath = join(directory, "fixture.tar");
  const compressedPath = join(directory, "fixture.tar.zst");
  let group: RegisteredGroup | undefined;
  let groupAbsent = false;
  let server: Server | undefined;
  let settleFeed: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  let pending: ReturnType<typeof runOwnedWorker> | undefined;
  let resultEvidence: Record<string, unknown> | undefined;
  const failures: unknown[] = [];
  try {
    for (const path of [home, staging, data, join(directory, "tmp"), join(directory, "Resources")])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const configuration = Buffer.from('{"synthetic":true}\n');
    const configPath = join(data, "mcp.json");
    await writeFile(configPath, configuration, { mode: 0o600 });
    await writeFile(
      join(directory, "Resources/version.json"),
      versionJson("0.3.0", "current1234"),
      { mode: 0o600 },
    );
    await mkdir(join(directory, "MacOS"), { mode: 0o700 });
    await writeFile(tarPath, options.tar, { mode: 0o600 });
    await checked(zstd, ["compress", "-i", tarPath, "-o", compressedPath, "--no-timing"]);
    const artifact = await readFile(compressedPath);
    if (options.refusal === "network")
      expect(artifact.byteLength).toBeGreaterThan(options.fileLimit);
    else expect(artifact.byteLength).toBeLessThan(options.fileLimit);
    const requests: string[] = [];
    let offeredBytes = 0;
    let observedDownloadBytes = 0;
    let feedFailure: unknown;
    expect(artifact.byteLength).toBeLessThan(4 * LIMIT);
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(path);
      if (path === MANIFEST_PATH) {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            identifier: UPDATER_IDENTIFIER,
            channel: UPDATER_CHANNEL,
            platform: "macos",
            arch: "arm64",
            version: TARGET_VERSION,
            hash: TARGET_HASH,
            artifact: { file: UPDATER_ARTIFACT_FILE },
          }),
        );
        return;
      }
      if (path !== ARTIFACT_PATH) {
        response.writeHead(404).end();
        return;
      }
      if (!options.chunked) response.setHeader("Content-Length", artifact.byteLength);
      settleFeed = (async () => {
        try {
          // These bounded synthetic bodies never enqueue more than 256 KiB.
          for (let offset = 0; offset < artifact.byteLength; offset += 16 * 1024) {
            // Observe the SDK's disk write before delivering the bytes over the cap.
            if (options.gateNetworkAtLimit && offset === options.fileLimit) {
              await eventually(async () => {
                if (controller.signal.aborted || response.destroyed) return true;
                const name = (await readdir(staging)).find((file) =>
                  file.endsWith(".tar.zst.partial"),
                );
                if (!name) return false;
                observedDownloadBytes = (await lstat(join(staging, name))).size;
                return observedDownloadBytes === options.fileLimit;
              }, 5_000);
            }
            if (controller.signal.aborted || response.destroyed) return;
            const end = Math.min(offset + 16 * 1024, artifact.byteLength);
            response.write(artifact.subarray(offset, end));
            offeredBytes = end;
          }
          response.end();
        } catch (error) {
          feedFailure = error;
          response.destroy();
        }
      })();
    });
    const feed = server;
    await new Promise<void>((resolve, reject) => {
      feed.once("error", reject);
      feed.listen(0, "127.0.0.1", () => {
        feed.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback feed address");
    pending = runOwnedWorker({
      command: bun,
      args: [WORKER],
      cwd: join(directory, "MacOS"),
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        TMPDIR: join(directory, "tmp"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        SDK_LIMIT_CASE_ROOT: directory,
        ...(options.resolverProbe ? { SDK_LIMIT_ROOT_PROBE: "1" } : {}),
        ...(options.resolverControl ? { SDK_LIMIT_ROOT_CONTROL: "1" } : {}),
        SDK_LIMIT_ORIGIN: `http://127.0.0.1:${address.port}`,
        MCP_GATEWAY_UPDATE_GRANT: "1",
        MCP_GATEWAY_UPDATE_RESULT: resultPath,
        MCP_GATEWAY_UPDATE_MAX_COMPRESSED_BYTES: String(options.fileLimit),
        MCP_GATEWAY_UPDATE_MAX_EXPANDED_BYTES: String(options.fileLimit),
      },
      resultPath,
      deadlineMs: 15_000,
      signal: controller.signal,
      fileSizeLimitBytes: options.fileLimit,
      requireGrant: true,
      onRegistered: async (pid) => {
        group = await captureRegisteredGroup({
          leaderPid: pid,
          helperPath: bun,
          planPath: resultPath,
        });
        expect(group.pgid).toBe(pid);
      },
    });
    const outcome = await pending;
    expect(outcome.closed).toBe(true);
    expect(group).toBeDefined();
    if (!group) throw new Error("Missing worker registration");
    const registered = group;
    await eventually(
      async () => (await inspectRegisteredGroup(registered)).status === "absent",
      3_000,
    );
    groupAbsent = true;
    await stopFeed(server);
    await settleFeed;
    expect(feedFailure).toBeUndefined();
    if (options.resolverProbe) {
      const resolution = JSON.parse(
        await readFile(join(directory, "root-resolution.json"), "utf8"),
      );
      expect(resolution.before).toBe(channel);
      expect(resolution.after).toBe(resolution.legacy);
      expect(resolution.after).not.toBe(channel);
      expect(outcome.status).toBe("failed");
      expect(requests).toEqual([]);
      expect(
        await readFile(join(resolution.legacy, "self-extraction/current1234.tar"), "utf8"),
      ).toBe("current-base");
      expect(await readdir(join(resolution.legacy, "self-extraction"))).toEqual([
        "current1234.tar",
      ]);
      expect(await Bun.file(join(staging, PREPARED_UPDATE_FILE)).exists()).toBe(false);
      const marker = join(resolution.legacy, ".electrobun-observed-update-result.json");
      const inventory = await inventoryBundle(resolution.legacy);
      if (options.resolverControl) {
        expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
          schema_version: 1,
          transaction_id: resolution.transactionId,
        });
        expect(inventory).not.toEqual(resolution.inventory);
      } else {
        expect(await Bun.file(marker).exists()).toBe(false);
        expect(inventory).toEqual(resolution.inventory);
      }
      resolverEvidence.push({
        ...resolution,
        unsafeGetterControl: options.resolverControl ?? false,
        zeroNetworkRequests: true,
        wholeLegacyRootUnchanged: !options.resolverControl,
        workerGroupAbsent: true,
      });
    } else {
      expect(requests).toEqual([MANIFEST_PATH, ARTIFACT_PATH]);
      const responses = (await readFile(join(directory, "http-responses.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses).toHaveLength(2);
      expect(responses[1]).toEqual({
        path: ARTIFACT_PATH,
        contentLength: options.chunked ? null : String(artifact.byteLength),
        transferEncoding: options.chunked ? "chunked" : null,
      });
      const statuses = (await readFile(join(directory, "sdk-status.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const names = statuses.map((entry) => entry.status);
      expect(names).toContain("local-tar-missing");
      expect(names).toContain("downloading-full-bundle");
      expect(names).not.toContain("applying");
      expect(names).not.toContain("fetching-patch");
      const prepared = join(staging, PREPARED_UPDATE_FILE);
      if (options.refusal) {
        expect(outcome.status).toBe("failed");
        expect(outcome.result).toBeUndefined();
        expect(names).toContain("error");
        if (options.refusal === "network") {
          expect(observedDownloadBytes).toBe(options.fileLimit);
          expect(offeredBytes).toBeGreaterThan(options.fileLimit);
          expect(names).not.toContain("decompressing");
        } else {
          expect(offeredBytes).toBe(artifact.byteLength);
          expect(statuses.find((entry) => entry.status === "decompressing")).toEqual({
            status: "decompressing",
            zstdPath: zstd,
          });
        }
        expect(names).not.toContain("download-complete");
        expect(await Bun.file(prepared).exists()).toBe(false);
        expect(await Bun.file(join(staging, `${TARGET_HASH}.tar`)).exists()).toBe(false);
      } else {
        expect(outcome.status).toBe("completed");
        expect(outcome.result).toEqual({
          status: "ready",
          selected: { version: TARGET_VERSION, hash: TARGET_HASH },
          channelRoot: channel,
        });
        expect(statuses.find((entry) => entry.status === "decompressing")).toEqual({
          status: "decompressing",
          zstdPath: zstd,
        });
        expect(names).toContain("download-complete");
        expect(sha256(await readFile(join(staging, `${TARGET_HASH}.tar`)))).toBe(
          sha256(options.tar),
        );
        expect(JSON.parse(await readFile(prepared, "utf8"))).toEqual({
          schema_version: 1,
          identifier: UPDATER_IDENTIFIER,
          channel: UPDATER_CHANNEL,
          version: TARGET_VERSION,
          hash: TARGET_HASH,
          platform: "macos",
          arch: "arm64",
          retained_tar_path: join(staging, `${TARGET_HASH}.tar`),
          artifact_file: UPDATER_ARTIFACT_FILE,
        });
      }
      const remaining = await readdir(staging);
      for (const name of remaining)
        expect((await lstat(join(staging, name))).size).toBeLessThanOrEqual(options.fileLimit);
      await cleanupInterruptedStaging({ channelRoot: channel, dataDirectory: data });
      expect(
        (await readdir(staging)).filter(
          (name) => name.endsWith(".partial") || name.endsWith(".tar.zst"),
        ),
      ).toEqual([]);
      expect(await readFile(configPath)).toEqual(configuration);
      resultEvidence = {
        name: options.name,
        outcome,
        fileLimitBytes: options.fileLimit,
        expandedLimitBytes: options.fileLimit,
        expandedBytes: options.tar.byteLength,
        compressedBytes: artifact.byteLength,
        compressedSha256: sha256(artifact),
        offeredBytes,
        observedDownloadBytes,
        chunked: options.chunked ?? false,
        responses,
        statuses,
        workerGroupAbsent: true,
        interruptedStagingClean: true,
        configurationUnchanged: true,
      };
    }
  } catch (error) {
    failures.push(error);
  } finally {
    controller.abort();
    for (const result of await Promise.allSettled([pending, stopFeed(server)]))
      if (result.status === "rejected") failures.push(result.reason);
    await settleFeed;
    try {
      if (group && !groupAbsent)
        groupAbsent = (await inspectRegisteredGroup(group)).status === "absent";
      // Keep uncertain ownership visible instead of deleting a live worker's directory.
      if (!pending || groupAbsent) await rm(directory, { recursive: true });
      else {
        cleanupConfirmed = false;
        failures.push(new Error(`SDK fixture process cleanup unconfirmed; retained ${directory}`));
      }
    } catch (error) {
      cleanupConfirmed = false;
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, `SDK limit case failed: ${options.name}`);
  if (resultEvidence) evidence.push(resultEvidence);
}

for (const chunked of [false, true]) {
  test(`real SDK limits ${chunked ? "chunked" : "Content-Length"} network writes`, async () => {
    const tar = archive(3 * LIMIT, true);
    await runCase({ name: `network-${chunked}-control`, tar, fileLimit: 4 * LIMIT, chunked });
    await runCase({
      name: `network-${chunked}-refusal`,
      tar,
      fileLimit: LIMIT,
      chunked,
      gateNetworkAtLimit: true,
      refusal: "network",
    });
  }, 40_000);
}

test("bundled zig-zstd accepts the exact expanded limit and rejects one extra TAR block", async () => {
  await runCase({ name: "expanded-exact-limit", tar: archive(LIMIT), fileLimit: LIMIT });
  const tar = archive(LIMIT + 512);
  await runCase({ name: "expanded-over-control", tar, fileLimit: 2 * LIMIT });
  await runCase({ name: "expanded-over-refusal", tar, fileLimit: LIMIT, refusal: "expansion" });
}, 50_000);

test("unchanged SDK root selection after canonical pruning refuses legacy work before network", async () => {
  await runCase({
    name: "legacy-root-refusal",
    tar: archive(LIMIT),
    fileLimit: 2 * LIMIT,
    resolverProbe: true,
  });
  await runCase({
    name: "legacy-root-unsafe-getter-control",
    tar: archive(LIMIT),
    fileLimit: 2 * LIMIT,
    resolverProbe: true,
    resolverControl: true,
  });
  expect(resolverEvidence).toHaveLength(2);
}, 30_000);

test("unchanged SDK main admission settles reconciliation under ownership on every supported exit", async () => {
  for (const mode of [
    "observed",
    "no-result",
    "cancelled",
    "metadata-error",
    "same-version",
    "resolver-error",
  ]) {
    const directory = await mkdtemp(join(root, `main-admission-${mode}-`));
    let group: RegisteredGroup | undefined;
    let closed = false;
    const failures: unknown[] = [];
    try {
      for (const path of ["home", "tmp", "Resources", "MacOS"])
        await mkdir(join(directory, path), { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "Resources/version.json"),
        versionJson("0.3.0", "current1234"),
        { mode: 0o600 },
      );
      const resultPath = join(directory, "worker-result.json");
      const outcome = await runOwnedWorker({
        command: bun,
        args: [join(PROJECT, "tests/fixtures/updater-sdk-admission.ts")],
        cwd: join(directory, "MacOS"),
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: join(directory, "home"),
          TMPDIR: join(directory, "tmp"),
          SDK_ADMISSION_ROOT: directory,
          SDK_ADMISSION_MODE: mode,
          MCP_GATEWAY_UPDATE_RESULT: resultPath,
          MCP_GATEWAY_UPDATE_GRANT: "1",
        },
        resultPath,
        deadlineMs: 15_000,
        fileSizeLimitBytes: 2 * LIMIT,
        requireGrant: true,
        onRegistered: async (pid) => {
          group = await captureRegisteredGroup({
            leaderPid: pid,
            helperPath: bun,
            planPath: resultPath,
          });
        },
      });
      closed = outcome.closed;
      expect(outcome).toMatchObject({
        status: "completed",
        closed: true,
        exitCode: 0,
        result: { status: "no-update" },
      });
      if (!group) throw new Error("Missing admission fixture ownership");
      const registered = group;
      await eventually(
        async () => (await inspectRegisteredGroup(registered)).status === "absent",
        3_000,
      );
      const record = JSON.parse(await readFile(join(directory, "admission-evidence.json"), "utf8"));
      expect(record).toMatchObject({
        mode,
        leaseHeldThroughSettlement: true,
        secondWriterRefused: true,
        unchangedAfterRelease: true,
      });
      admissionEvidence.push(record);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (closed && (!group || (await inspectRegisteredGroup(group)).status === "absent")) {
          if (failures.length === 0) await rm(directory, { recursive: true });
        } else {
          cleanupConfirmed = false;
          failures.push(
            new Error("Admission fixture cleanup unconfirmed; retained isolated directory"),
          );
        }
      } catch (error) {
        cleanupConfirmed = false;
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, `SDK admission case failed: ${mode}`);
  }
}, 100_000);
