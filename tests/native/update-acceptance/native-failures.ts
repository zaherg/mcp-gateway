import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnOwned } from "../../../scripts/native-process";
import { withDmgMount } from "../../../scripts/release-dmg";
import { compareBundleInventories, inventoryBundle } from "../../../scripts/release-inventory";
import {
  retainPreviousApplication,
  verifyRetainedRecovery,
} from "../../../src/main/updater/recovery";
import { ApplicationVerifier, runCommand } from "../../../src/main/updater/verify";
import { assertFixtureBase } from "./prepare-fixture-apps";
import { stopApp } from "./product-update-flow";

const ROOT = process.cwd();
const OUT = resolve(
  process.env.MCP_GATEWAY_MATRIX_ROOT ?? ".cache/update-acceptance/native-failures",
);
const PRODUCT = resolve(process.env.MCP_GATEWAY_MATRIX_APP ?? "MISSING-PAYLOAD");
const ID = "dev.srvr.mcpgateway";
const FEED = "https://github.com/zaherg/mcp-gateway/releases/latest/download";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
let identity = "";
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error("Native failure acceptance cancelled"));
const evidence: Record<string, unknown> = { schemaVersion: 2, ok: false, cases: {}, cleanup: [] };
const cases: Record<string, unknown> = {};
const apps = new Set<string>();

async function command(args: [string, ...string[]], timeout = 60_000): Promise<string> {
  const result = await runCommand(args[0], args.slice(1), timeout, cancellation.signal);
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed with exit ${result.exitCode}`);
  return result.stdout;
}
async function optional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function markers(path: string): Promise<string[]> {
  return (await optional(path))?.trim().split("\n").filter(Boolean) ?? [];
}
async function makeApp(
  path: string,
  version: string,
  routingHash: string,
  marker: string,
  extraBytes = 0,
) {
  await mkdir(join(path, "Contents/MacOS"), { recursive: true });
  await mkdir(join(path, "Contents/Resources"), { recursive: true });
  const source = join(path, "Contents/Resources/stub.c");
  await writeFile(
    source,
    `#include <stdio.h>\nint main(void) { FILE *f=fopen(${JSON.stringify(marker)},"a"); if(!f) return 2; fputs(${JSON.stringify(`${version}\n`)},f); return fclose(f); }\n`,
  );
  await command([
    "/usr/bin/xcrun",
    "clang",
    "-arch",
    "arm64",
    "-mmacosx-version-min=14.0",
    source,
    "-o",
    join(path, "Contents/MacOS/launcher"),
  ]);
  // The application verifier requires the pinned executable layout even for small helper fixtures.
  for (const name of ["bun", "bspatch", "zig-zstd"])
    await cp(join(path, "Contents/MacOS/launcher"), join(path, "Contents/MacOS", name));
  await writeFile(
    join(path, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${ID}</string><key>CFBundleName</key><string>MCP Gateway</string><key>CFBundleExecutable</key><string>launcher</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  );
  await writeFile(
    join(path, "Contents/Resources/version.json"),
    JSON.stringify({
      version,
      hash: routingHash,
      identifier: ID,
      channel: "stable",
      baseUrl: FEED,
      name: "MCPGateway",
      displayName: "MCP Gateway",
    }),
  );
  await cp(
    join(PRODUCT, "Contents/Resources/uninstall"),
    join(path, "Contents/Resources/uninstall"),
  );
  if (extraBytes)
    await writeFile(join(path, "Contents/Resources/large.bin"), Buffer.alloc(extraBytes, 65));
  await command([
    "/usr/bin/codesign",
    "--force",
    "--deep",
    "--sign",
    identity,
    "--identifier",
    ID,
    "--options",
    "runtime",
    "--timestamp=none",
    path,
  ]);
}
async function fixture(name: string, homeOverride?: string, extraBytes = 0) {
  const root = join(OUT, name);
  await mkdir(root, { mode: 0o700 });
  const home = homeOverride ?? join(root, "home");
  const channel = join(home, "Library/Application Support", ID, "stable");
  const app = join(home, "Applications/MCP Gateway.app");
  const data = join(root, "data");
  const tmp = join(root, "tmp");
  const payload = join(root, "payload");
  const marker = join(home, "launch-marker");
  for (const path of [home, channel, data, tmp, payload, join(channel, "self-extraction")])
    await mkdir(path, { recursive: true, mode: 0o700 });
  apps.add(app);
  await makeApp(app, "0.3.1", "current1234", marker);
  const target = join(payload, "MCP Gateway.app");
  await makeApp(target, "0.3.2", "next123456", marker, extraBytes);
  const tx = randomBytes(16).toString("hex");
  const tar = join(channel, "self-extraction/next123456.tar");
  await command(["/usr/bin/tar", "--format=ustar", "-cf", tar, "-C", payload, "MCP Gateway.app"]);
  const nonce = randomBytes(16).toString("hex");
  await writeFile(
    join(channel, ".electrobun-uninstall.json"),
    JSON.stringify({
      schema_version: 1,
      install_nonce: nonce,
      identifier: ID,
      name: "MCP Gateway",
      channel: "stable",
      version: "0.3.1",
      app_bundle_path: app,
      app_path_token: hash(`${nonce}\0${ID}\0stable\0${app}\0`),
      data_path_versions: [1],
      install_root_name: "stable",
    }),
  );
  const resultPath = join(channel, `.electrobun-update-${tx}.result.json`);
  const planPath = join(channel, `.electrobun-update-${tx}.json`);
  const plan = {
    schema_version: 1,
    transaction_id: tx,
    identifier: ID,
    channel: "stable",
    platform: "macos",
    arch: "arm64",
    version: "0.3.2",
    hash: "next123456",
    channel_root: channel,
    app_bundle_path: app,
    retained_tar_path: tar,
    parent_pid: 2147483647,
    result_path: resultPath,
  };
  await writeFile(planPath, JSON.stringify(plan));
  const helper = join(tmp, `electrobun-update-${tx}`);
  await cp(join(PRODUCT, "Contents/Resources/uninstall"), helper);
  await chmod(helper, 0o700);
  const config = join(data, "mcp.jsonc");
  const bytes =
    '// Preserve comments and exact bytes\n{"gateway":{"host":"127.0.0.1","port":8765,"token":"synthetic-token-0123456789abcdef"},"mcpServers":{}}\n';
  await writeFile(config, bytes, { mode: 0o600 });
  const verifier = new ApplicationVerifier();
  const publisher = await verifier.readPublisher(app);
  const original = await inventoryBundle(app);
  return {
    root,
    home,
    channel,
    app,
    data,
    tmp,
    payload,
    target,
    marker,
    tar,
    tx,
    resultPath,
    planPath,
    plan,
    helper,
    config,
    bytes,
    verifier,
    publisher,
    original,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function invoke(f: Fixture, limited = false, whileRunning?: () => Promise<void>) {
  const args = [f.helper, "--apply-update", f.planPath, "--quiet"];
  const proc = spawnOwned(
    limited ? ["/bin/bash", "-c", 'ulimit -f 1; exec "$@"', "fixture", ...args] : args,
    ROOT,
    {
      HOME: f.home,
      CFFIXED_USER_HOME: f.home,
      TMPDIR: f.tmp,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1",
    },
  );
  const stdout = new Response(proc.child.stdout).text();
  const stderr = new Response(proc.child.stderr).text();
  const timer = setTimeout(() => proc.signal(), 20_000);
  cancellation.signal.addEventListener("abort", proc.signal, { once: true });
  try {
    await whileRunning?.();
    const exit = await Promise.race([
      proc.child.exited,
      Bun.sleep(25_000).then(() => {
        throw new Error("Native helper deadline exceeded");
      }),
    ]);
    cancellation.signal.throwIfAborted();
    const text = await optional(f.resultPath);
    const result = text === undefined ? null : JSON.parse(text);
    if (result) {
      assert.equal(result.schema_version, 1);
      assert.equal(result.transaction_id, f.tx);
      assert.equal(result.identifier, ID);
      assert.equal(result.channel, "stable");
      assert.equal(result.version, f.plan.version);
      assert.equal(result.hash, f.plan.hash);
    }
    return { exit, result };
  } finally {
    clearTimeout(timer);
    cancellation.signal.removeEventListener("abort", proc.signal);
    await proc.stop();
    await Promise.all([stdout, stderr]);
  }
}
function recoveryInventory(f: Fixture) {
  return f.original.map((entry) =>
    entry.type === "directory" ? { ...entry, mode: entry.mode & 0o700 } : entry,
  );
}
async function preserved(f: Fixture, recovered = false) {
  compareBundleInventories(
    recovered ? recoveryInventory(f) : f.original,
    await inventoryBundle(f.app),
    { expected: "original app", actual: "failed update app" },
  );
  assert.equal(await readFile(f.config, "utf8"), f.bytes);
}
async function assertLaunches(f: Fixture, previous: boolean) {
  const deadline = Date.now() + (previous ? 10_000 : 1_000);
  while (Date.now() < deadline) {
    const values = await markers(f.marker);
    assert(
      values.every((version) => version === "0.3.1"),
      "Failed update launched the target version",
    );
    if (previous && values.length > 0) break;
    await Bun.sleep(100);
  }
  await Bun.sleep(1_000);
  assert.deepEqual(await markers(f.marker), previous ? ["0.3.1"] : []);
}
async function failure(name: string, f: Fixture, expectedMessage: string, limited = false) {
  const outcome = await invoke(f, limited);
  assert.notEqual(outcome.exit, 0);
  if (limited) assert.equal(outcome.result, null);
  else {
    assert.equal(outcome.result?.success, false);
    assert.equal(outcome.result?.message, expectedMessage);
  }
  await preserved(f);
  await assertLaunches(f, !limited);
  if (name === "moving-mismatch") assert.equal(outcome.result?.phase, "validating_payload");
  cases[name] = {
    ...outcome,
    appInventoryPreserved: true,
    configurationByteIdentical: true,
    previousRelaunched: !limited,
    targetNotLaunched: true,
  };
}
async function main() {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  if (process.env.MCP_GATEWAY_ALLOW_ENOSPC_IMAGE !== "1")
    throw new Error("Authorize the isolated 8 MiB image with MCP_GATEWAY_ALLOW_ENOSPC_IMAGE=1");
  await assertFixtureBase(PRODUCT);
  await assertFixtureBase(OUT);
  assert.equal(await realpath(PRODUCT), PRODUCT);
  process.env.TMPDIR = join(OUT, "tmp");
  process.env.CLANG_MODULE_CACHE_PATH = join(OUT, "clang-cache");
  await mkdir(OUT, { mode: 0o700 });
  await mkdir(process.env.TMPDIR, { mode: 0o700 });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await command(["/usr/bin/codesign", "--verify", "--deep", "--strict", PRODUCT]);
    const version = JSON.parse(
      await readFile(join(PRODUCT, "Contents/Resources/version.json"), "utf8"),
    );
    assert.equal(version.version, "0.3.1");
    assert.equal(version.identifier, ID);
    const ids = await command(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"]);
    const found = [...ids.matchAll(/\b[A-Fa-f0-9]{40} "(Developer ID Application: [^"]+)"/g)];
    assert.equal(found.length, 1);
    const foundIdentity = found[0]?.[1];
    assert(foundIdentity, "Signing identity unavailable");
    identity = foundIdentity;
    evidence.product = {
      version: version.version,
      hash: version.hash,
      helperSha256: hash(await readFile(join(PRODUCT, "Contents/Resources/uninstall"))),
    };
    {
      const f = await fixture("success");
      await retainPreviousApplication({
        appBundlePath: f.app,
        dataDirectory: f.data,
        publisher: f.publisher,
        version: "0.3.1",
        hash: "current1234",
        verifier: f.verifier,
      });
      const outcome = await invoke(f);
      assert.equal(outcome.exit, 0);
      assert.equal(outcome.result?.success, true);
      const deadline = Date.now() + 10_000;
      while ((await markers(f.marker)).length === 0 && Date.now() < deadline) await Bun.sleep(100);
      await Bun.sleep(1_000);
      assert.deepEqual(await markers(f.marker), ["0.3.2"]);
      await f.verifier.verifyCandidate(f.app, {
        publisher: f.publisher,
        version: "0.3.2",
        hash: "next123456",
      });
      const previous = await verifyRetainedRecovery({
        dataDirectory: f.data,
        publisher: f.publisher,
        verifier: f.verifier,
      });
      compareBundleInventories(
        recoveryInventory(f),
        await inventoryBundle(previous.record.retained_bundle_path),
        { expected: "original", actual: "recovery" },
      );
      assert.equal(await readFile(f.config, "utf8"), f.bytes);
      cases.success = {
        ...outcome,
        singleLaunch: true,
        configurationByteIdentical: true,
        verifiedRecoveryInventory: true,
      };
    }
    {
      const f = await fixture("parent-wait");
      const parent = spawnOwned(["/bin/sleep", "30"], ROOT, { PATH: "/usr/bin:/bin" });
      try {
        f.plan.parent_pid = parent.child.pid;
        await writeFile(f.planPath, JSON.stringify(f.plan));
        const outcome = await invoke(f, false, async () => {
          await Bun.sleep(750);
          assert.equal(parent.child.exitCode, null);
          assert.equal(await optional(f.resultPath), undefined);
          await preserved(f);
          assert.deepEqual(await markers(f.marker), []);
          await parent.stop();
        });
        assert.equal(outcome.exit, 0);
        assert.equal(outcome.result?.success, true);
        const deadline = Date.now() + 10_000;
        while ((await markers(f.marker)).length === 0 && Date.now() < deadline)
          await Bun.sleep(100);
        assert.deepEqual(await markers(f.marker), ["0.3.2"]);
        cases["parent-wait"] = { ...outcome, parentWaitObserved: true, singleTargetLaunch: true };
      } finally {
        await parent.stop();
      }
    }
    {
      const f = await fixture("publisher-mismatch");
      const expected = { publisher: f.publisher, version: "0.3.2", hash: "next123456" };
      await f.verifier.verifyCandidate(f.target, expected);
      const differentTeam = f.publisher.teamId === "ZZZZZZZZZZ" ? "YYYYYYYYYY" : "ZZZZZZZZZZ";
      await assert.rejects(
        f.verifier.verifyCandidate(f.target, {
          ...expected,
          publisher: { ...f.publisher, teamId: differentTeam },
        }),
        { code: "candidate_signature_requirement_failed" },
      );
      await preserved(f);
      await assertLaunches(f, false);
      cases["publisher-mismatch"] = {
        matchingPublisherControlPassed: true,
        mismatchedPublisherRefusedByCodesign: true,
        helperNotStarted: true,
        configurationByteIdentical: true,
      };
    }
    {
      const f = await fixture("incompatible-host");
      await command([
        "/usr/bin/plutil",
        "-insert",
        "LSMinimumSystemVersion",
        "-string",
        "99.0",
        join(f.target, "Contents/Info.plist"),
      ]);
      await command([
        "/usr/bin/codesign",
        "--force",
        "--deep",
        "--sign",
        identity,
        "--options",
        "runtime",
        "--timestamp=none",
        f.target,
      ]);
      await command(["/usr/bin/codesign", "--verify", "--deep", "--strict", f.target]);
      await assert.rejects(
        f.verifier.verifyCandidate(f.target, {
          publisher: f.publisher,
          version: "0.3.2",
          hash: "next123456",
        }),
        { code: "candidate_macos_incompatible" },
      );
      await preserved(f);
      await assertLaunches(f, false);
      cases["incompatible-host"] = {
        signedCandidate: true,
        applicationRefusedBeforeHandoff: true,
        appInventoryPreserved: true,
        configurationByteIdentical: true,
      };
    }
    {
      const f = await fixture("integration-rollback");
      // The native helper swaps first, then atomically replaces this manager file.
      // A directory collision reaches its integration failure and rollback path.
      await mkdir(join(f.channel, "uninstall"));
      const outcome = await invoke(f);
      assert.notEqual(outcome.exit, 0);
      assert.equal(outcome.result?.success, false);
      assert.equal(outcome.result?.phase, "integrating");
      await preserved(f);
      await assertLaunches(f, true);
      cases["integration-rollback"] = {
        ...outcome,
        automaticRollbackVerified: true,
        previousRelaunched: true,
        appInventoryPreserved: true,
        configurationByteIdentical: true,
      };
    }
    {
      const f = await fixture("moving-mismatch");
      f.plan.hash = "other123456";
      f.plan.retained_tar_path = join(f.channel, "self-extraction/other123456.tar");
      await rename(f.tar, f.plan.retained_tar_path);
      await writeFile(f.planPath, JSON.stringify(f.plan));
      await failure("moving-mismatch", f, "InvalidUpdateIdentity");
    }
    {
      const f = await fixture("read-only");
      const parent = join(f.home, "Applications");
      await chmod(parent, 0o555);
      try {
        await failure("read-only", f, "AccessDenied");
      } finally {
        await chmod(parent, 0o755);
      }
    }
    {
      const f = await fixture("interrupted");
      await retainPreviousApplication({
        appBundlePath: f.app,
        dataDirectory: f.data,
        publisher: f.publisher,
        version: "0.3.1",
        hash: "current1234",
        verifier: f.verifier,
      });
      await rename(f.app, `${f.app}.previous`);
      const outcome = await invoke(f);
      assert.notEqual(outcome.exit, 0);
      assert.equal(outcome.result?.success, false);
      assert.equal(outcome.result?.message, "FileNotFound");
      await assert.rejects(lstat(f.app), { code: "ENOENT" });
      const previous = await verifyRetainedRecovery({
        dataDirectory: f.data,
        publisher: f.publisher,
        verifier: f.verifier,
      });
      await cp(previous.record.retained_bundle_path, f.app, {
        recursive: true,
        preserveTimestamps: true,
      });
      await preserved(f, true);
      await assertLaunches(f, false);
      await f.verifier.verifyCandidate(f.app, {
        publisher: f.publisher,
        version: "0.3.1",
        hash: "current1234",
      });
      cases.interrupted = {
        ...outcome,
        manualRecoveryVerified: true,
        restoredInventoryIdentical: true,
        configurationByteIdentical: true,
      };
    }
    await failure("write-limit", await fixture("write-limit"), "", true);
    {
      const image = join(OUT, "disk-full.sparseimage");
      await command([
        "/usr/bin/hdiutil",
        "create",
        "-size",
        "8m",
        "-fs",
        "HFS+",
        "-volname",
        "MCPGatewayFull",
        "-type",
        "SPARSE",
        image,
      ]);
      await withDmgMount(
        image,
        OUT,
        async (mount) => {
          const f = await fixture("disk-full", mount, 5 * 1024 * 1024);
          try {
            await failure("disk-full", f, "NoSpaceLeft");
          } finally {
            await stopApp(f.app);
            apps.delete(f.app);
          }
        },
        {
          signal: cancellation.signal,
          run: (cmd, args, timeout, signal) =>
            runCommand(
              cmd,
              cmd === "/usr/bin/hdiutil" && args[0] === "attach"
                ? args.filter((arg) => arg !== "-readonly")
                : args,
              timeout,
              signal,
            ),
          onCleanup: (result) => {
            evidence.diskCleanup = result;
          },
        },
      );
    }
    {
      const f = await fixture("invalid-candidate");
      await writeFile(join(f.target, "Contents/Resources/uninstall"), "tampered\n");
      await assert.rejects(
        f.verifier.verifyCandidate(f.target, {
          publisher: f.publisher,
          version: "0.3.2",
          hash: "next123456",
        }),
        { code: "candidate_signature_invalid" },
      );
      await preserved(f);
      await assertLaunches(f, false);
      cases["invalid-candidate"] = {
        rejected: true,
        helperNotStarted: true,
        appInventoryPreserved: true,
        configurationByteIdentical: true,
      };
    }
    assert.equal(Object.keys(cases).length, 11);
    evidence.assertionsPassed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : "Acceptance failed";
    for (const name of ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_APP_PASSWORD"])
      if (process.env[name])
        evidence.error = String(evidence.error).split(process.env[name]).join("[redacted]");
    process.exitCode = 1;
  } finally {
    const failures: string[] = [];
    for (const app of apps) {
      try {
        await stopApp(app);
      } catch {
        failures.push(app);
      }
    }
    evidence.cleanup = { ok: failures.length === 0, failedOwnedApps: failures };
    evidence.cases = cases;
    evidence.ok = evidence.assertionsPassed === true && failures.length === 0;
    if (!evidence.ok) process.exitCode = 1;
    await writeFile(join(OUT, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    console.log(JSON.stringify({ ok: evidence.ok, evidence: join(OUT, "evidence.json") }));
  }
}
await main().catch(() => {
  console.error("Native failure setup refused; retained evidence requires inspection.");
  process.exitCode = 1;
});
