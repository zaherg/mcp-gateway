import { test as bunTest, expect } from "bun:test";

// Transaction integration acquires the macOS kernel guard; policy tests remain portable.
const test = bunTest.skipIf(process.platform !== "darwin");

import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  INSTALLATION_ENABLED,
  UpdateBoundaryError,
  UpdaterSafetyBoundary,
} from "../../src/main/updater/boundary";
import {
  type ExpectedNativePlan,
  nativeResultPath,
  readLease,
  TransactionLease,
} from "../../src/main/updater/transaction";
import {
  ApplicationVerifier,
  type CommandResult,
  type CommandRunner,
} from "../../src/main/updater/verify";
import { parseBuildIdentity } from "../../src/shared/build-identity";
import { versionJson, writeBundleFixture } from "../fixtures/updater";

const _TEAM = "ABCDEFGHIJ";
const WORKER = resolve("tests/fixtures/updater-boundary-worker.ts");
const HASH = "target123456";

function success(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0 };
}

function fakeRunner(options: { failCandidate?: boolean } = {}): CommandRunner {
  return async (command, args) => {
    if (command.endsWith("plutil")) {
      if (args.includes("CFBundleIdentifier")) return success("dev.srvr.mcpgateway\n");
      if (args.includes("CFBundleVersion")) {
        const bundle = dirname(dirname(args.at(-1) ?? ""));
        const document = JSON.parse(
          readFileSync(join(bundle, "Contents/Resources/version.json"), "utf8"),
        );
        return success(`${document.version}\n`);
      }
      return success("launcher\n");
    }
    if (command.endsWith("lipo")) return success("arm64\n");
    if (command.endsWith("codesign")) {
      if (args.includes("--display"))
        return success(
          "",
          "Identifier=dev.srvr.mcpgateway\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Example\n",
        );
      if (options.failCandidate && args.includes("-R"))
        return { stdout: "", stderr: "", exitCode: 1 };
      return success();
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
}

async function setup(
  scenario = "success",
  verifier?: ApplicationVerifier,
): Promise<{
  root: string;
  data: string;
  home: string;
  channel: string;
  app: string;
  boundary: UpdaterSafetyBoundary;
}> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-boundary-"));
  const data = join(root, "data");
  const home = join(root, "home");
  const channel = join(home, "Library/Application Support/dev.srvr.mcpgateway/stable");
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const app = writeBundleFixture(join(root, "Applications"), {
    version: "0.3.0",
    hash: "current1234",
  });
  const boundary = new UpdaterSafetyBoundary({
    appBundlePath: app,
    dataDirectory: data,
    channelRoot: channel,
    home,
    appDataDirectory: join(home, "Library/Application Support"),
    deadlineMs: 5_000,
    preparation: {
      command: process.execPath,
      args: [WORKER],
      cwd: resolve("."),
      env: { WORKER_SCENARIO: scenario },
    },
    verifier: verifier ?? new ApplicationVerifier(fakeRunner()),
  });
  return { root, data, home, channel, app, boundary };
}

for (const method of ["checkForUpdate", "prepareUpdateAttempt"] as const) {
  test(`${method} rejects unsafe staging before cleanup, pruning or worker creation`, async () => {
    const fixture = await setup();
    try {
      const target = join(fixture.root, "unrelated");
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, "notes.tar"), "keep original bytes\n");
      await mkdir(fixture.channel, { recursive: true, mode: 0o700 });
      await symlink(target, join(fixture.channel, "self-extraction"));
      await expect(fixture.boundary[method]()).rejects.toMatchObject({ code: "state" });
      expect(await readdir(target)).toEqual(["notes.tar"]);
      expect(await readFile(join(target, "notes.tar"), "utf8")).toBe("keep original bytes\n");
      expect(await readdir(fixture.channel)).toEqual(["self-extraction"]);
      expect(await readdir(fixture.data)).toEqual([]);
    } finally {
      await fixture.boundary.abandonPrepared();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("service manual checks cannot contend with deferred startup reconciliation", async () => {
  const fixture = await setup();
  const { setup: controllerFixture } = await import("../core/helpers");
  const { AppService } = await import("../../src/main/service");
  const { UpdaterCoordinator } = await import("../../src/main/updater/coordinator");
  const context = await controllerFixture();
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let checks = 0;
  const updates = new UpdaterCoordinator({
    dataDirectory: fixture.data,
    supported: true,
    installedVersion: "0.3.0",
    runtime: {
      reconcile: async () => {
        await barrier;
        return fixture.boundary.reconcile();
      },
      checkForUpdate: () => {
        checks++;
        return fixture.boundary.checkForUpdate();
      },
      prepareUpdateAttempt: () => fixture.boundary.prepareUpdateAttempt(),
      revalidate: (candidate, signal) => fixture.boundary.revalidate(candidate, signal),
    },
  });
  const idle = { attempt: 0, phase: "idle", error: null } as const;
  const login = { enabled: false, supported: false, error: null };
  const service = new AppService(
    context.controller,
    { status: () => login, setEnabled: () => login },
    () => {},
    { platform: "macos", requestQuit: () => idle, quitStatus: () => idle },
    updates,
  );
  try {
    await updates.start({ reconcile: false });
    expect(await service.handlers.updatesCheck()).toMatchObject({
      ok: false,
      error: { code: "UpdateBusy" },
    });
    const initialization = updates.completeInitialization();
    expect(await service.handlers.updatesCheck()).toMatchObject({
      ok: false,
      error: { code: "UpdateBusy" },
    });
    expect(checks).toBe(0);
    finish();
    await initialization;
    expect(updates.statusValue().recoveryRequired).toBe(false);
  } finally {
    finish();
    updates.stop();
    await fixture.boundary.abandonPrepared();
    await context.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inaccessible updater storage is contained while gateway initialization and start remain usable", async () => {
  const fixture = await setup();
  const { chmod } = await import("node:fs/promises");
  const { setup: controllerFixture } = await import("../core/helpers");
  const { AppService } = await import("../../src/main/service");
  const { UpdaterCoordinator } = await import("../../src/main/updater/coordinator");
  const context = await controllerFixture();
  const updates = new UpdaterCoordinator({
    dataDirectory: fixture.data,
    supported: true,
    installedVersion: "0.3.0",
    runtime: fixture.boundary,
  });
  try {
    await mkdir(fixture.channel, { recursive: true, mode: 0o700 });
    await chmod(fixture.channel, 0o000);
    expect(await updates.start()).toMatchObject({ phase: "error", recoveryRequired: true });
    const idle = { attempt: 0, phase: "idle", error: null } as const;
    const login = { enabled: false, supported: false, error: null };
    const service = new AppService(
      context.controller,
      {
        status: () => login,
        setEnabled: () => login,
      },
      () => {},
      { platform: "macos", requestQuit: () => idle, quitStatus: () => idle },
      updates,
    );
    expect(await service.handlers.snapshot()).toMatchObject({
      ok: true,
      value: {
        gateway: { configError: null },
        update: { phase: "error", recoveryRequired: true },
      },
    });
    expect(await service.handlers.start()).toMatchObject({
      ok: true,
      value: { gateway: { running: true } },
    });
    expect(await service.handlers.updatesCheck()).toMatchObject({
      ok: false,
      error: { code: "UpdateRecoveryRequired" },
    });
  } finally {
    updates.stop();
    await chmod(fixture.channel, 0o700);
    await fixture.boundary.abandonPrepared();
    await context.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("prepares, freezes, verifies, and retains the previous app with installation enabled", async () => {
  const fixture = await setup();
  try {
    expect(fixture.boundary.installationEnabled).toBe(true);
    expect(INSTALLATION_ENABLED).toBe(true);
    const attempt = await fixture.boundary.prepareUpdateAttempt();
    expect(attempt.candidate.version).toBe("0.3.1");
    expect(attempt.candidate.hash).toBe(HASH);
    expect(attempt.metadata.identifier).toBe("dev.srvr.mcpgateway");
    expect(attempt.recovery.version).toBe("0.3.0");
    expect(attempt.recovery.manual_only).toBe(true);
    const frozen = await fixture.boundary.revalidate(attempt.candidate);
    expect(frozen.candidate.archive_sha256).toBe(attempt.candidate.archive_sha256);
    const candidates = await readdir(join(fixture.data, "updates/candidates"));
    expect(candidates).toEqual([`${HASH}.json`]);
    const runs = await readdir(join(fixture.data, "updates/tmp"));
    expect(runs).toEqual([]);
    const recovery = await stat(attempt.recovery.retained_bundle_path);
    expect(recovery.isDirectory()).toBe(true);
    expect(attempt.candidate.archive_sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ordinary Quit refuses a replaced candidates directory and preserves its retained lease", async () => {
  const fixture = await setup();
  const candidates = join(fixture.data, "updates/candidates");
  const retained = join(fixture.data, "updates/candidates-original");
  let replaced = false;
  try {
    await fixture.boundary.prepareUpdateAttempt();
    const journal = await readLease(fixture.channel);
    const target = join(fixture.root, "unrelated");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, `${HASH}.json`), "keep unrelated bytes\n", { mode: 0o600 });
    await rename(candidates, retained);
    await symlink(target, candidates);
    replaced = true;
    await expect(fixture.boundary.abandonPrepared()).rejects.toThrow();
    expect(await readFile(join(target, `${HASH}.json`), "utf8")).toBe("keep unrelated bytes\n");
    expect(await readdir(target)).toEqual([`${HASH}.json`]);
    expect(await readLease(fixture.channel)).toEqual(journal);
  } finally {
    if (replaced) {
      await rm(candidates);
      await rename(retained, candidates);
    }
    await fixture.boundary.abandonPrepared();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("holds one transaction lease across final validation and rejects a second application writer", async () => {
  const fixture = await setup();
  try {
    const attempt = await fixture.boundary.prepareUpdateAttempt();
    const second = new UpdaterSafetyBoundary({
      appBundlePath: fixture.app,
      dataDirectory: fixture.data,
      channelRoot: fixture.channel,
      home: fixture.home,
      appDataDirectory: join(fixture.home, "Library/Application Support"),
      deadlineMs: 5_000,
      preparation: { command: process.execPath, args: [WORKER], cwd: resolve(".") },
      verifier: new ApplicationVerifier(fakeRunner()),
    });
    await expect(second.prepareUpdateAttempt()).rejects.toMatchObject({ code: "busy" });
    await expect(second.checkForUpdate()).rejects.toMatchObject({ code: "busy" });
    expect((await fixture.boundary.revalidate(attempt.candidate)).candidate.hash).toBe(HASH);
    await fixture.boundary.abandonPrepared();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a shared archive changed after approval even with the same selected labels", async () => {
  const fixture = await setup();
  try {
    const attempt = await fixture.boundary.prepareUpdateAttempt();
    await writeFile(
      attempt.candidate.retained_tar_path,
      Buffer.concat([readFileSync(attempt.candidate.retained_tar_path), Buffer.from("x")]),
    );
    await expect(fixture.boundary.revalidate(attempt.candidate)).rejects.toMatchObject({
      code: "prepared",
    });
    await fixture.boundary.abandonPrepared().catch(() => undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("checks availability in an owned worker without preparing or retaining a candidate", async () => {
  const fixture = await setup("check");
  try {
    const result = await fixture.boundary.checkForUpdate();
    expect(result).toEqual({
      available: true,
      version: "0.3.1",
      hash: HASH,
      currentVersion: "0.3.0",
    });
    const extraction = await readdir(join(fixture.channel, "self-extraction")).catch(() => []);
    expect(extraction).toEqual([]);
    const recovery = await readdir(join(fixture.data, "updates/recovery")).catch(() => []);
    expect(recovery).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports no update from an owned check without a prepared record", async () => {
  const fixture = await setup("no-update");
  try {
    expect(await fixture.boundary.checkForUpdate()).toEqual({
      available: false,
      version: null,
      hash: null,
      currentVersion: "0.3.0",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a worker selection that differs from the prepared record", async () => {
  const fixture = await setup("bad-selection");
  return (async () => {
    try {
      await fixture.boundary.prepareUpdateAttempt();
      throw new Error("Expected selection rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UpdateBoundaryError);
      expect((error as UpdateBoundaryError).code).toBe("selection");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  })();
});

test("discards frozen state when the extracted candidate fails publisher verification", async () => {
  const fixture = await setup();
  try {
    const rejecting = new UpdaterSafetyBoundary({
      appBundlePath: fixture.app,
      dataDirectory: fixture.data,
      channelRoot: fixture.channel,
      home: fixture.home,
      appDataDirectory: join(fixture.home, "Library/Application Support"),
      deadlineMs: 5_000,
      preparation: {
        command: process.execPath,
        args: [WORKER],
        cwd: resolve("."),
        env: { WORKER_SCENARIO: "success" },
      },
      verifier: new ApplicationVerifier(fakeRunner({ failCandidate: true })),
    });
    try {
      await rejecting.prepareUpdateAttempt();
      throw new Error("Expected signature rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UpdateBoundaryError);
      expect((error as UpdateBoundaryError).code).toBe("signature");
    }
    const candidates = await readdir(join(fixture.data, "updates/candidates")).catch(() => []);
    expect(candidates).toEqual([]);
    const extraction = await readdir(join(fixture.channel, "self-extraction"));
    expect(extraction).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("times out an owned worker without retaining the previous application", async () => {
  const fixture = await setup();
  try {
    const timed = new UpdaterSafetyBoundary({
      appBundlePath: fixture.app,
      dataDirectory: fixture.data,
      channelRoot: fixture.channel,
      home: fixture.home,
      appDataDirectory: join(fixture.home, "Library/Application Support"),
      deadlineMs: 250,
      preparation: {
        command: process.execPath,
        args: [WORKER],
        cwd: resolve("."),
        env: { WORKER_SCENARIO: "timeout" },
      },
      verifier: new ApplicationVerifier(fakeRunner()),
    });
    try {
      await timed.prepareUpdateAttempt();
      throw new Error("Expected timeout");
    } catch (error) {
      expect((error as UpdateBoundaryError).code).toBe("workerTimeout");
    }
    const recovery = await readdir(join(fixture.data, "updates/recovery")).catch(() => []);
    expect(recovery).toEqual([]);
    const runs = await readdir(join(fixture.data, "updates/tmp"));
    expect(runs).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses a channel root outside the isolated home identity", async () => {
  const fixture = await setup();
  try {
    expect(
      () =>
        new UpdaterSafetyBoundary({
          appBundlePath: fixture.app,
          dataDirectory: fixture.data,
          channelRoot: join(fixture.root, "other"),
          home: fixture.home,
          appDataDirectory: join(fixture.home, "Library/Application Support"),
          verifier: new ApplicationVerifier(fakeRunner()),
        }),
    ).toThrow("installed application identity");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function blockingRunner(options: {
  blockPath: (path: string) => boolean;
  started: () => void;
  gate: Promise<void>;
}): CommandRunner {
  const normal = fakeRunner();
  return async (command, args, timeout, signal) => {
    const path = args.at(-1) ?? "";
    if (command.endsWith("codesign") && args.includes("--verify") && options.blockPath(path)) {
      options.started();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        options.gate.then(resolve, reject);
      });
    }
    return normal(command, args, timeout, signal);
  };
}

test("captures cancellation before the initial signature inspection can start worker network work", async () => {
  let startedResolve: () => void = () => {};
  let releaseGate: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const fixture = await setup(
    "check",
    new ApplicationVerifier(
      blockingRunner({
        blockPath: (path) => path.includes("/Applications/"),
        started: startedResolve,
        gate,
      }),
    ),
  );
  try {
    const pending = fixture.boundary.checkForUpdate();
    await started;
    fixture.boundary.cancel();
    releaseGate();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(await readdir(join(fixture.channel, "self-extraction")).catch(() => [])).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses post-transfer publication and cleans state when cancelled during candidate verification", async () => {
  let startedResolve: () => void = () => {};
  let releaseGate: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const fixture = await setup(
    "success",
    new ApplicationVerifier(
      blockingRunner({
        blockPath: (path) => path.includes("/extracted/") || path.includes("run-"),
        started: startedResolve,
        gate,
      }),
    ),
  );
  try {
    const pending = fixture.boundary.prepareUpdateAttempt();
    await started;
    fixture.boundary.cancel();
    releaseGate();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(await readdir(join(fixture.channel, "self-extraction")).catch(() => [])).toEqual([]);
    expect(await readdir(join(fixture.data, "updates/candidates")).catch(() => [])).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function fakeSdk(
  options: { root?: string; version?: string; hash?: string; helper?: string } = {},
) {
  const calls = { local: 0, root: 0 };
  return {
    calls,
    sdk: {
      applyUpdate: async () => {},
      onStatusChange: () => {},
      getLocalInfo: async () => {
        calls.local++;
        return {
          identifier: "dev.srvr.mcpgateway",
          channel: "stable",
          baseUrl: "https://github.com/zaherg/mcp-gateway/releases/latest/download",
          version: options.version ?? "0.3.0",
          hash: options.hash ?? "current1234",
          name: "MCPGateway",
        };
      },
      appDataFolder: async () => {
        calls.root++;
        return options.root ?? "";
      },
    },
  };
}

test("builds a preflight handoff only after canonical SDK root/helper/parent checks", async () => {
  const fixture = await setup();
  const controller = new AbortController();
  try {
    const prepared = await fixture.boundary.prepareUpdateAttempt();
    fixture.boundary.setHandoffAuthority({
      isCurrentUpdate: () => true,
      isCleanupComplete: () => true,
      attemptSignal: () => controller.signal,
    });
    const fake = fakeSdk({ root: fixture.channel });
    const session = await fixture.boundary.prepareHandoff(
      { id: 7, candidate: prepared.candidate, signal: controller.signal },
      fake.sdk,
    );
    expect(session.attemptId).toBe(7);
    expect(fake.calls).toEqual({ local: 1, root: 1 });
    const journal = await readLease(fixture.channel);
    expect(journal).toMatchObject({
      phase: "preflight",
      attempt_id: 7,
      expected_native: { channelRoot: fixture.channel, parentPid: process.pid },
    });
    session.releaseGuard();
    await fixture.boundary.abandonPrepared();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses an alternative SDK root, running hash mismatch, or differing cached helper", async () => {
  const rootMismatch = await setup();
  try {
    const prepared = await rootMismatch.boundary.prepareUpdateAttempt();
    rootMismatch.boundary.setHandoffAuthority({
      isCurrentUpdate: () => true,
      isCleanupComplete: () => true,
      attemptSignal: () => new AbortController().signal,
    });
    await expect(
      rootMismatch.boundary.prepareHandoff(
        { id: 1, candidate: prepared.candidate, signal: new AbortController().signal },
        fakeSdk({ root: join(rootMismatch.root, "legacy") }).sdk,
      ),
    ).rejects.toMatchObject({ code: "identity" });
    await rootMismatch.boundary.abandonPrepared();
  } finally {
    await rm(rootMismatch.root, { recursive: true, force: true });
  }

  const hashMismatch = await setup();
  try {
    const prepared = await hashMismatch.boundary.prepareUpdateAttempt();
    hashMismatch.boundary.setHandoffAuthority({
      isCurrentUpdate: () => true,
      isCleanupComplete: () => true,
      attemptSignal: () => new AbortController().signal,
    });
    await expect(
      hashMismatch.boundary.prepareHandoff(
        { id: 1, candidate: prepared.candidate, signal: new AbortController().signal },
        fakeSdk({ root: hashMismatch.channel, hash: "other123456" }).sdk,
      ),
    ).rejects.toMatchObject({ code: "identity" });
    await hashMismatch.boundary.abandonPrepared();
  } finally {
    await rm(hashMismatch.root, { recursive: true, force: true });
  }

  const helperMismatch = await setup();
  try {
    const prepared = await helperMismatch.boundary.prepareUpdateAttempt();
    await writeFile(join(helperMismatch.channel, "uninstall"), "different helper", {
      mode: 0o755,
    });
    helperMismatch.boundary.setHandoffAuthority({
      isCurrentUpdate: () => true,
      isCleanupComplete: () => true,
      attemptSignal: () => new AbortController().signal,
    });
    await expect(
      helperMismatch.boundary.prepareHandoff(
        { id: 1, candidate: prepared.candidate, signal: new AbortController().signal },
        fakeSdk({ root: helperMismatch.channel }).sdk,
      ),
    ).rejects.toMatchObject({ code: "identity" });
    await helperMismatch.boundary.abandonPrepared();
  } finally {
    await rm(helperMismatch.root, { recursive: true, force: true });
  }
});

test("binds the SDK launcher parent PID rather than assuming the runtime PID", async () => {
  const fixture = await setup();
  const previous = process.env.ELECTROBUN_LAUNCHER_PID;
  process.env.ELECTROBUN_LAUNCHER_PID = "12345";
  try {
    const prepared = await fixture.boundary.prepareUpdateAttempt();
    fixture.boundary.setHandoffAuthority({
      isCurrentUpdate: () => true,
      isCleanupComplete: () => true,
      attemptSignal: () => new AbortController().signal,
    });
    const session = await fixture.boundary.prepareHandoff(
      { id: 2, candidate: prepared.candidate, signal: new AbortController().signal },
      fakeSdk({ root: fixture.channel }).sdk,
    );
    expect(session.expected.parentPid).toBe(12345);
    session.releaseGuard();
    await fixture.boundary.abandonPrepared();
  } finally {
    if (previous === undefined) delete process.env.ELECTROBUN_LAUNCHER_PID;
    else process.env.ELECTROBUN_LAUNCHER_PID = previous;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup reconciliation waits for a late exact result only after initialization", async () => {
  const fixture = await setup();
  await mkdir(join(fixture.root, "tmp"), { recursive: true, mode: 0o700 });
  const temporary = await realpath(join(fixture.root, "tmp"));
  try {
    const candidate = {
      schema_version: 1,
      identifier: "dev.srvr.mcpgateway",
      channel: "stable",
      version: "0.3.1",
      hash: "target123456",
      artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
      prepared_path: "/synthetic/prepared.json",
      prepared_sha256: "a".repeat(64),
      retained_tar_path: "/synthetic/target.tar",
      archive_sha256: "b".repeat(64),
      archive_bytes: 1,
      frozen_at: "2026-11-03T00:00:00.000Z",
    } as const;
    const lease = await TransactionLease.acquire({
      channelRoot: fixture.channel,
      dataDirectory: fixture.data,
      appBundlePath: fixture.app,
    });
    await lease.markPrepared(candidate, null);
    const attempt = { id: 3, candidate, signal: new AbortController().signal };
    const expected: ExpectedNativePlan = {
      identifier: "dev.srvr.mcpgateway",
      channel: "stable",
      platform: "macos",
      arch: "arm64",
      version: "0.3.1",
      hash: "target123456",
      channelRoot: fixture.channel,
      appBundlePath: fixture.app,
      retainedTarPath: candidate.retained_tar_path,
      parentPid: 999,
      physicalTemporaryDirectory: temporary,
    };
    await lease.prepareHandoff(attempt, expected, []);
    const identity = { nonce: lease.snapshot().lease_id, attemptId: 3 };
    lease.armHandoffSync(identity);
    const id = "0123456789abcdef0123456789abcdef";
    lease.bindNativeSync(identity, {
      evidence: "observed-plan",
      transactionId: id,
      planPath: join(fixture.channel, `.electrobun-update-${id}.json`),
      resultPath: nativeResultPath(fixture.channel, id),
      helperPath: join(temporary, `electrobun-update-${id}`),
      plan: expected,
    });
    lease.releaseGuard();
    await writeFile(
      join(fixture.app, "Contents/Resources/version.json"),
      versionJson("0.3.1", "target123456"),
      { mode: 0o600 },
    );
    setTimeout(() => {
      void writeFile(
        nativeResultPath(fixture.channel, id),
        JSON.stringify({
          schema_version: 1,
          transaction_id: id,
          success: true,
          phase: "complete",
          message: "Update applied successfully.",
          identifier: "dev.srvr.mcpgateway",
          channel: "stable",
          version: "0.3.1",
          hash: "target123456",
        }),
        { mode: 0o644 },
      );
    }, 150);
    const executingBuild = parseBuildIdentity({
      schema_version: 1,
      identifier: "dev.srvr.mcpgateway",
      version: "0.3.1",
      build_id: "a".repeat(64),
    });
    await mkdir(join(fixture.app, "Contents/Resources/app"));
    await writeFile(
      join(fixture.app, "Contents/Resources/app/build-identity.json"),
      JSON.stringify(executingBuild),
    );
    // Only the replacement's executing identity may confirm its late result.
    const running = new UpdaterSafetyBoundary({
      appBundlePath: fixture.app,
      dataDirectory: fixture.data,
      channelRoot: fixture.channel,
      home: fixture.home,
      appDataDirectory: join(fixture.home, "Library/Application Support"),
      executingBuild,
      verifier: new ApplicationVerifier(fakeRunner()),
    });
    const outcome = await running.reconcile();
    expect(outcome).toMatchObject({ status: "confirmed", version: "0.3.1", hash: "target123456" });
    expect(await readLease(fixture.channel)).toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation before lease acquisition releases the acquired journal", async () => {
  const fixture = await setup("check");
  try {
    const pending = fixture.boundary.checkForUpdate();
    fixture.boundary.cancel();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(await readdir(join(fixture.channel, "self-extraction")).catch(() => [])).toEqual([]);
    await expect(
      import("node:fs/promises").then(({ lstat }) =>
        lstat(join(fixture.channel, ".mcp-gateway-update-transaction")),
      ),
    ).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("prunes cached current TAR and prepared SDK state before full-archive preparation", async () => {
  const fixture = await setup();
  try {
    const staging = join(fixture.channel, "self-extraction");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(staging, "current1234.tar"), "cached-patch-base", { mode: 0o600 });
    await writeFile(join(staging, ".electrobun-prepared-update.json"), "{}\n", { mode: 0o600 });
    await fixture.boundary.prepareUpdateAttempt();
    await expect(
      import("node:fs/promises").then(({ lstat }) => lstat(join(staging, "current1234.tar"))),
    ).rejects.toThrow();
    expect(await readdir(staging)).toContain("target123456.tar");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("abandonment joins paused real work and its cleanup before a second writer can acquire", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const normal = fakeRunner();
  const fixture = await setup(
    "check",
    new ApplicationVerifier(async (...args) => {
      if (args[0].endsWith("plutil")) {
        entered.resolve();
        await release.promise;
      }
      return normal(...args);
    }),
  );
  try {
    const check = fixture.boundary.checkForUpdate().catch((error) => error.code);
    await entered.promise;
    let abandoned = false;
    const abandon = fixture.boundary.abandonPrepared().then(() => {
      abandoned = true;
    });
    const again = fixture.boundary.abandonPrepared();
    await Bun.sleep(20);
    expect(abandoned).toBe(false);
    await expect(
      TransactionLease.acquire({
        channelRoot: fixture.channel,
        dataDirectory: fixture.data,
        appBundlePath: fixture.app,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    release.resolve();
    expect(await check).toBe("cancelled");
    await Promise.all([abandon, again]);
    const second = await TransactionLease.acquire({
      channelRoot: fixture.channel,
      dataDirectory: fixture.data,
      appBundlePath: fixture.app,
    });
    const run = join(fixture.data, "updates/tmp/run-ABCDEF");
    await mkdir(run, { recursive: true, mode: 0o700 });
    await writeFile(join(run, "marker"), "second-writer", { mode: 0o600 });
    await fixture.boundary.abandonPrepared();
    expect(await Bun.file(join(run, "marker")).text()).toBe("second-writer");
    await second.releaseUncommitted();
  } finally {
    release.resolve();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function integrated(
  fixture: Awaited<ReturnType<typeof setup>>,
  options: {
    cleanup?: () => Promise<void>;
    beforePreflight?: () => Promise<void>;
    check?: () => Promise<import("../../src/main/updater/boundary").UpdateCheckResult>;
    beforeAbandon?: () => Promise<void>;
    beforeDispatch?: () => Promise<void>;
    apply?: (
      sdk: import("../../src/main/updater/apply").ApplySdk,
      quit: import("../../src/main/lifecycle").QuitCoordinator,
      attempt: import("../../src/main/updater/transaction").UpdateAttempt,
      emit: (status: string) => void,
    ) => Promise<void>;
  } = {},
) {
  const { QuitCoordinator } = await import("../../src/main/lifecycle");
  const { UpdaterCoordinator } = await import("../../src/main/updater/coordinator");
  const { withQuitInvocation } = await import("../../src/main/updater/invocation");
  const { applyVerifiedUpdate } = await import("../../src/main/updater/apply");
  const { saveUpdatePreferences, DEFAULT_UPDATE_PREFERENCES } = await import(
    "../../src/main/updater/preferences"
  );
  await saveUpdatePreferences(fixture.data, false, DEFAULT_UPDATE_PREFERENCES);
  const counts = { cleanup: 0, dispatch: 0, sessions: 0, applies: 0, quits: 0, preflights: 0 };
  let updates!: InstanceType<typeof UpdaterCoordinator>;
  const quit = new QuitCoordinator(
    async () => {
      counts.cleanup++;
      updates.stop();
      await options.cleanup?.();
    },
    () => {
      counts.quits++;
    },
    (_error, kind, settlement) => {
      if (kind === "update")
        updates.markHandoffFailed(quit.status().error ?? undefined, settlement);
    },
    async (attempt) => {
      counts.dispatch++;
      await options.beforeDispatch?.();
      let callback: ((entry: Readonly<{ status: string }>) => void) | null = null;
      const sdk: import("../../src/main/updater/apply").ApplySdk = fakeSdk({
        root: fixture.channel,
      }).sdk;
      sdk.onStatusChange = (next: typeof callback) => {
        callback = next;
      };
      sdk.applyUpdate = async () => {
        counts.applies++;
        if (options.apply)
          await options.apply(sdk, quit, attempt, (status) => callback?.({ status }));
        else callback?.({ status: "idle" });
      };
      const session = await fixture.boundary.prepareHandoff(attempt, sdk);
      counts.sessions++;
      expect(quit.registerHandoff(session)).toBe(true);
      let retained = false;
      try {
        const result = await applyVerifiedUpdate(attempt, session, sdk);
        if (result.settlement.kind === "unarmed") retained = true;
        return result.settlement;
      } finally {
        quit.unregisterHandoff(session);
        if (!retained) session.releaseGuard();
      }
    },
    () => updates.abandonPrepared(),
  );
  fixture.boundary.setHandoffAuthority(quit.handoffAuthority);
  updates = new UpdaterCoordinator({
    dataDirectory: fixture.data,
    supported: true,
    installationEnabled: true,
    installedVersion: "0.3.0",
    runtime: {
      checkForUpdate:
        options.check ??
        (async () => ({ available: true, version: "0.3.1", hash: HASH, currentVersion: "0.3.0" })),
      prepareUpdateAttempt: () => fixture.boundary.prepareUpdateAttempt(),
      revalidate: async (candidate, signal) => {
        counts.preflights++;
        await options.beforePreflight?.();
        return fixture.boundary.revalidate(candidate, signal);
      },
      cancel: () => fixture.boundary.cancel(),
      abandonPrepared: async () => {
        await options.beforeAbandon?.();
        await fixture.boundary.abandonPrepared();
      },
    },
    terminal: {
      reserveUpdate: (candidate) => quit.reserveUpdate(candidate),
      requestRestartToUpdate: (attempt) => {
        const accepted = quit.acceptUpdateRestart(attempt);
        if (accepted)
          withQuitInvocation({ kind: "begin-update-shutdown", attemptId: attempt.id }, () =>
            quit.handle(() => {}),
          );
        return { accepted, status: quit.status() };
      },
      cancelUpdate: (id) => quit.cancelUpdate(id),
    },
  });
  await updates.start();
  await updates.check();
  await updates.download();
  const ordinaryQuit = () => {
    quit.armQuit();
    quit.handle(() => {});
  };
  return { updates, quit, counts, ordinaryQuit };
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Integration boundary timed out");
    await Bun.sleep(5);
  }
}

test("queued duplicate failure cannot become a new retry without fresh service admission", async () => {
  const fixture = await setup();
  const gate = deferred<void>();
  let first = true;
  const { setup: controllerFixture } = await import("../core/helpers");
  const context = await controllerFixture();
  const rig = await integrated(fixture, {
    beforePreflight: async () => {
      if (first) {
        first = false;
        await gate.promise;
        throw new Error("transient preflight failure");
      }
    },
  });
  try {
    const { AppService } = await import("../../src/main/service");
    const { MacLoginManager } = await import("../../src/main/login");
    const service = new AppService(
      context.controller,
      new MacLoginManager({ status: () => 0, set: () => 0 }),
      () => {},
      {
        platform: "macos",
        requestQuit: () => {
          rig.ordinaryQuit();
          return rig.quit.status();
        },
        quitStatus: () => rig.quit.status(),
      },
      rig.updates,
    );
    const one = service.handlers.updatesRestart({ version: "0.3.1", hash: HASH });
    const two = service.handlers.updatesRestart({ version: "0.3.1", hash: HASH });
    await until(() => rig.counts.preflights === 1);
    const admitted = rig.updates.statusValue().attemptId;
    gate.resolve();
    expect((await one).ok).toBe(false);
    expect((await two).ok).toBe(false);
    expect(rig.counts).toMatchObject({ preflights: 1, cleanup: 0, dispatch: 0 });
    expect(rig.updates.statusValue()).toMatchObject({ phase: "error", readyVersion: "0.3.1" });
    expect((await service.handlers.updatesRestart({ version: "0.3.1", hash: HASH })).ok).toBe(true);
    await until(() => rig.counts.applies === 1 && rig.quit.status().phase === "failed");
    expect(rig.quit.status().attempt).toBeGreaterThan(admitted ?? 0);
    expect(rig.counts).toMatchObject({ preflights: 2, cleanup: 1, dispatch: 1 });
  } finally {
    gate.resolve();
    rig.ordinaryQuit();
    await fixture.boundary.abandonPrepared();
    await context.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("duplicate service admissions share one preflight, cleanup, handoff session and SDK dispatch", async () => {
  const fixture = await setup();
  const preflight = deferred<void>();
  const dispatch = deferred<void>();
  const { setup: controllerFixture } = await import("../core/helpers");
  const context = await controllerFixture();
  try {
    const rig = await integrated(fixture, {
      beforePreflight: () => preflight.promise,
      beforeDispatch: () => dispatch.promise,
    });
    const { AppService } = await import("../../src/main/service");
    const { MacLoginManager } = await import("../../src/main/login");
    const app = new AppService(
      context.controller,
      new MacLoginManager({ status: () => 0, set: () => 0 }),
      () => {},
      {
        platform: "macos",
        requestQuit: () => {
          rig.ordinaryQuit();
          return rig.quit.status();
        },
        quitStatus: () => rig.quit.status(),
      },
      rig.updates,
    );
    const first = app.handlers.updatesRestart({ version: "0.3.1", hash: HASH });
    const second = app.handlers.updatesRestart({ version: "0.3.1", hash: HASH });
    await until(() => rig.counts.preflights === 1);
    expect(rig.updates.statusValue().attemptId).toBeGreaterThan(0);
    preflight.resolve();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    await until(() => rig.counts.dispatch === 1);
    const repeated = await rig.updates.restartToUpdate("0.3.1", HASH);
    expect(repeated.phase).toBe("pending");
    expect(rig.counts.cleanup).toBe(1);
    expect(rig.counts.preflights).toBe(1);
    dispatch.resolve();
    await until(() => rig.quit.status().phase === "failed");
    expect(rig.counts).toMatchObject({ cleanup: 1, dispatch: 1, sessions: 1, applies: 1 });
    rig.ordinaryQuit();
    await until(() => rig.counts.quits === 1);
    expect(await readLease(fixture.channel)).toBeUndefined();
  } finally {
    preflight.resolve();
    dispatch.resolve();
    await context.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup and pre-handoff failures preserve real candidate bytes and lease for an exact retry", async () => {
  const fixture = await setup();
  let cleanups = 0;
  let dispatches = 0;
  try {
    const rig = await integrated(fixture, {
      cleanup: async () => {
        if (++cleanups === 1) throw new Error("synthetic cleanup failure");
      },
      beforeDispatch: async () => {
        if (++dispatches === 1) throw new Error("synthetic pre-handoff failure");
      },
    });
    const original = (await readLease(fixture.channel))?.candidate;
    if (!original) throw new Error("Missing real prepared candidate");
    for (let i = 0; i < 3; i++) {
      await rig.updates.restartToUpdate("0.3.1", HASH);
      await until(() => rig.quit.status().phase === "failed");
      expect(rig.updates.statusValue()).toMatchObject({
        phase: "error",
        readyVersion: "0.3.1",
        attemptId: null,
        recoveryRequired: false,
      });
      expect((await readLease(fixture.channel))?.candidate).toEqual(original);
      expect(await Bun.file(original.retained_tar_path).exists()).toBe(true);
      expect(await Bun.file(original.prepared_path).exists()).toBe(true);
    }
    expect(rig.counts.applies).toBe(1);
    expect(rig.counts.sessions).toBe(1);
    expect((await readLease(fixture.channel))?.phase).toBe("prepared");
    rig.ordinaryQuit();
    await until(() => rig.counts.quits === 1);
    expect(await readLease(fixture.channel)).toBeUndefined();
    expect(await Bun.file(original.retained_tar_path).exists()).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("failed unarmed restoration clears retry readiness and preserves the journal until safe Quit", async () => {
  const fixture = await setup();
  const { chmod } = await import("node:fs/promises");
  const directory = join(fixture.channel, ".mcp-gateway-update-transaction");
  const rig = await integrated(fixture, {
    apply: async (_sdk, quit, _attempt, emit) => {
      await chmod(directory, 0o500);
      let vetoed = false;
      quit.handle(() => {
        vetoed = true;
      });
      expect(vetoed).toBe(true);
      emit("idle");
    },
  });
  try {
    await rig.updates.restartToUpdate("0.3.1", HASH);
    await until(() => rig.quit.status().phase === "failed");
    expect(rig.updates.statusValue()).toMatchObject({
      readyVersion: null,
      recoveryRequired: true,
      phase: "error",
    });
    expect((await readLease(fixture.channel))?.phase).toBe("preflight");
    rig.ordinaryQuit();
    await until(() => rig.quit.status().error?.startsWith("Quit cleanup failed.") === true);
    expect(rig.counts.quits).toBe(0);
    expect(await readLease(fixture.channel)).toBeDefined();
    await chmod(directory, 0o700);
    await expect(rig.updates.restartToUpdate("0.3.1", HASH)).rejects.toMatchObject({
      code: "UpdateNotReady",
    });
    expect(await readLease(fixture.channel)).toBeDefined();
    rig.ordinaryQuit();
    await until(() => rig.counts.quits === 1);
    expect(await readLease(fixture.channel)).toBeUndefined();
  } finally {
    await chmod(directory, 0o700).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    rig.ordinaryQuit();
    await fixture.boundary.abandonPrepared();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const branch of ["arming-refused", "copy-error", "bound-error"] as const) {
  test(`returned SDK ${branch} publishes authoritative retry or committed recovery and permits ordinary Quit`, async () => {
    const fixture = await setup();
    try {
      const rig = await integrated(fixture, {
        apply: async (_sdk, quit, attempt, emit) => {
          const { chmod } = await import("node:fs/promises");
          const directory = join(fixture.channel, ".mcp-gateway-update-transaction");
          if (branch === "arming-refused") await chmod(directory, 0o500);
          let vetoed = false;
          try {
            quit.handle(() => {
              vetoed = true;
            });
          } finally {
            await chmod(directory, 0o700);
          }
          if (vetoed) {
            emit("idle");
            return;
          }
          emit("applying");
          if (branch === "bound-error") {
            const id = "abcdefabcdefabcdefabcdefabcdefab";
            const journal = await readLease(fixture.channel);
            const expected = journal?.expected_native;
            if (!expected) throw new Error("Missing checked native input");
            await writeFile(
              join(fixture.channel, `.electrobun-update-${id}.json`),
              JSON.stringify({
                schema_version: 1,
                transaction_id: id,
                identifier: expected.identifier,
                channel: expected.channel,
                platform: expected.platform,
                arch: expected.arch,
                version: attempt.candidate.version,
                hash: attempt.candidate.hash,
                app_bundle_path: expected.appBundlePath,
                channel_root: expected.channelRoot,
                parent_pid: expected.parentPid,
                retained_tar_path: expected.retainedTarPath,
                result_path: nativeResultPath(fixture.channel, id),
              }),
              { mode: 0o600 },
            );
            emit("launching-new-version");
          }
          emit("error");
        },
      });
      await rig.updates.restartToUpdate("0.3.1", HASH);
      await until(() => rig.quit.status().phase === "failed");
      const status = rig.updates.statusValue();
      if (branch === "arming-refused") {
        expect(status).toMatchObject({
          phase: "error",
          readyVersion: "0.3.1",
          attemptId: null,
          recoveryRequired: false,
        });
        expect((await readLease(fixture.channel))?.phase).toBe("prepared");
      } else {
        expect(status).toMatchObject({
          phase: "error",
          readyVersion: null,
          recoveryRequired: true,
        });
        expect(status.attemptId).toBeGreaterThan(0);
        await expect(rig.updates.restartToUpdate("0.3.1", HASH)).rejects.toMatchObject({
          code: "UpdateNotReady",
        });
        expect((await readLease(fixture.channel))?.phase).toBe(
          branch === "bound-error" ? "handed-off" : "arming",
        );
      }
      rig.ordinaryQuit();
      await until(() => rig.counts.quits === 1);
      expect(Boolean(await readLease(fixture.channel))).toBe(branch !== "arming-refused");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("verification errors and delayed close retain operation ownership beyond the old escape timer", async () => {
  const child = Bun.spawn([process.execPath, resolve("tests/fixtures/updater-command-close.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new Response(child.stdout).text();
  const err = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    expect(await child.exited).toBe(0);
    expect(await err).toBe("");
    expect(await out).toBe("delayed-close-ownership-and-definite-spawn-failure=passed\n");
  } finally {
    clearTimeout(timeout);
  }
});

function stopVerificationChild(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

for (const stage of ["initial preflight", "final handoff"] as const) {
  test(`ordinary Quit cancels and joins an actual verification child during ${stage}`, async () => {
    let enabled = false;
    let inspections = 0;
    let marker = "";
    const normal = fakeRunner();
    const fixture = await setup(
      "success",
      new ApplicationVerifier(async (command, args, timeout, signal) => {
        if (enabled && command.endsWith("plutil") && args.includes("CFBundleIdentifier")) {
          inspections++;
          if (inspections === (stage === "initial preflight" ? 1 : 2)) {
            expect(signal).toBeDefined();
            const { runCommand } = await import("../../src/main/updater/verify");
            return runCommand(
              process.execPath,
              [
                "-e",
                'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)',
                marker,
              ],
              30000,
              signal,
            );
          }
        }
        return normal(command, args, timeout, signal);
      }),
    );
    marker = join(fixture.root, "verification.pid");
    let rig: Awaited<ReturnType<typeof integrated>> | undefined;
    let restarting: Promise<unknown> | undefined;
    let pid: number | undefined;
    try {
      rig = await integrated(fixture);
      enabled = true;
      restarting = rig.updates.restartToUpdate("0.3.1", HASH).catch((error) => error.code);
      await until(() => Bun.file(marker).exists());
      pid = Number(await Bun.file(marker).text());
      process.kill(pid, 0);
      rig.ordinaryQuit();
      rig.quit.handle(() => {});
      await restarting;
      await until(() => rig?.counts.quits === 1);
      const exitedPid = pid;
      expect(() => process.kill(exitedPid, 0)).toThrow();
      expect(rig.counts.applies).toBe(0);
      expect(await readLease(fixture.channel)).toBeUndefined();
    } finally {
      fixture.boundary.cancel();
      if (pid) stopVerificationChild(pid);
      await restarting;
      rig?.ordinaryQuit();
      await fixture.boundary.abandonPrepared();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("moving-latest mismatch retires the refused real preparation before a fresh check/download", async () => {
  const fixture = await setup("moving-latest");
  let checks = 0;
  try {
    const rig = await integrated(fixture, {
      check: async () => ({
        available: true,
        version: ++checks === 1 ? "0.3.1" : "0.3.2",
        hash: HASH,
        currentVersion: "0.3.0",
      }),
    });
    expect(rig.updates.statusValue()).toMatchObject({
      phase: "error",
      availableVersion: null,
      availableHash: null,
      readyVersion: null,
      recoveryRequired: false,
    });
    expect(await readLease(fixture.channel)).toBeUndefined();
    expect(await Bun.file(join(fixture.channel, "self-extraction/target123456.tar")).exists()).toBe(
      false,
    );
    await rig.updates.check();
    await rig.updates.download();
    expect(rig.updates.statusValue()).toMatchObject({ phase: "ready", readyVersion: "0.3.2" });
    expect((await readLease(fixture.channel))?.phase).toBe("prepared");
    rig.ordinaryQuit();
    await until(() => rig.counts.quits === 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a refused moving-latest preparation with failed retirement exposes recovery, not Retry Check", async () => {
  const fixture = await setup("moving-latest");
  const { chmod } = await import("node:fs/promises");
  try {
    const rig = await integrated(fixture, {
      beforeAbandon: () => chmod(join(fixture.data, "updates/candidates"), 0o500),
    });
    expect(rig.updates.statusValue()).toMatchObject({
      phase: "error",
      readyVersion: null,
      availableVersion: null,
      recoveryRequired: true,
    });
    expect(await readLease(fixture.channel)).toBeDefined();
    await expect(rig.updates.check()).rejects.toMatchObject({ code: "UpdateRecoveryRequired" });
    await chmod(join(fixture.data, "updates/candidates"), 0o700);
    await fixture.boundary.abandonPrepared();
    rig.updates.stop();
  } finally {
    await chmod(join(fixture.data, "updates/candidates"), 0o700).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});
