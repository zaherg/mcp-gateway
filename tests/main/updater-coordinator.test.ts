import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PreparedUpdateAttempt, UpdateCheckResult } from "../../src/main/updater/boundary";
import type { FrozenCandidate } from "../../src/main/updater/candidate";
import {
  UpdatePolicyError,
  type UpdateRuntime,
  UpdaterCoordinator,
  type UpdaterTimers,
} from "../../src/main/updater/coordinator";
import type { UpdateAttempt } from "../../src/main/updater/transaction";
import type { QuitStatus } from "../../src/shared/rpc";
import { eventually } from "../core/helpers";

const HASH = "next123456";
const VERSION = "0.3.2";

function candidate(version = VERSION, hash = HASH): FrozenCandidate {
  return {
    schema_version: 1,
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    version,
    hash,
    artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
    prepared_path: "/synthetic/prepared.json",
    prepared_sha256: "a".repeat(64),
    retained_tar_path: "/synthetic/target.tar",
    archive_sha256: "b".repeat(64),
    archive_bytes: 1,
    frozen_at: "2026-11-03T00:00:00.000Z",
  };
}

function attempt(version = VERSION, hash = HASH): PreparedUpdateAttempt {
  return {
    candidate: candidate(version, hash),
    admission: {
      path: "/synthetic/target.tar",
      bytes: 1,
      sha256: "b".repeat(64),
      bundleName: "x.app",
      entries: [],
    },
    metadata: {
      identifier: "dev.srvr.mcpgateway",
      version,
      hash,
      channel: "stable",
      baseUrl: "",
      displayName: "MCP Gateway",
      executable: "launcher",
      architectures: ["arm64"],
      bundlePath: "/synthetic/x.app",
    },
    recovery: {
      schema_version: 1,
      identifier: "dev.srvr.mcpgateway",
      version: "0.3.1",
      hash: "current1234",
      retained_bundle_path: "/synthetic/previous.app",
      created_at: "2026-11-03T00:00:00.000Z",
      manual_only: true,
    },
    previous: {
      identifier: "dev.srvr.mcpgateway",
      version: "0.3.1",
      hash: "current1234",
      channel: "stable",
      baseUrl: "https://example.invalid",
      displayName: "MCP Gateway",
      executable: "launcher",
      architectures: ["arm64"],
      bundlePath: "/synthetic/current.app",
    },
  } as PreparedUpdateAttempt;
}

class FakeTimers implements UpdaterTimers {
  nowValue = 0;
  startup: (() => void) | undefined;
  poll: (() => void) | undefined;
  cleared = 0;
  setTimeout(callback: () => void, _milliseconds: number): ReturnType<typeof setTimeout> {
    this.startup = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(_handle: ReturnType<typeof setTimeout>): void {
    this.cleared++;
    this.startup = undefined;
  }
  setInterval(callback: () => void, _milliseconds: number): ReturnType<typeof setInterval> {
    this.poll = callback;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }
  clearInterval(_handle: ReturnType<typeof setInterval>): void {
    this.cleared++;
    this.poll = undefined;
  }
  now(): number {
    return this.nowValue;
  }
  runStartup(): void {
    this.startup?.();
  }
  runPoll(advanceMs: number): void {
    this.nowValue += advanceMs;
    this.poll?.();
  }
}

function runtime(
  options: {
    check?: () => Promise<UpdateCheckResult>;
    prepare?: () => Promise<PreparedUpdateAttempt>;
    reconcile?: UpdateRuntime["reconcile"];
  } = {},
): UpdateRuntime & {
  checks: number;
  downloads: number;
  revalidations: number;
  cancels: number;
  abandons: number;
} {
  const result = {
    checks: 0,
    downloads: 0,
    revalidations: 0,
    cancels: 0,
    abandons: 0,
    checkForUpdate: async (): Promise<UpdateCheckResult> => {
      result.checks++;
      return options.check
        ? options.check()
        : { available: true, version: VERSION, hash: HASH, currentVersion: "0.3.1" };
    },
    prepareUpdateAttempt: async (): Promise<PreparedUpdateAttempt> => {
      result.downloads++;
      return options.prepare ? options.prepare() : attempt();
    },
    revalidate: async () => {
      result.revalidations++;
    },
    reconcile: options.reconcile,
    abandonPrepared: async () => {
      result.abandons++;
    },
    cancel: () => {
      result.cancels++;
    },
  };
  return result;
}

async function directory(): Promise<string> {
  await mkdir(resolve(".cache"), { recursive: true });
  return mkdtemp(resolve(".cache/updater-coordinator-"));
}

function terminal() {
  const status: QuitStatus = { attempt: 1, phase: "pending", error: null };
  let reserved: UpdateAttempt | undefined;
  const result = {
    calls: 0,
    cancels: 0,
    reserveUpdate: (candidate: FrozenCandidate): UpdateAttempt | undefined => {
      reserved ??= { id: 1, candidate, signal: new AbortController().signal };
      return reserved;
    },
    requestRestartToUpdate: (_attempt: UpdateAttempt) => {
      result.calls++;
      return { accepted: true, status };
    },
    cancelUpdate: () => {
      result.cancels++;
      reserved = undefined;
    },
  };
  return result;
}

test("manual and automatic update work stays closed until shared startup reconciliation settles", async () => {
  const data = await directory();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let reconciliations = 0;
  const updater = runtime({
    reconcile: async () => {
      reconciliations++;
      await pending;
      return { status: "confirmed", version: VERSION, hash: HASH };
    },
  });
  const timers = new FakeTimers();
  const coordinator = new UpdaterCoordinator({
    dataDirectory: data,
    supported: true,
    installedVersion: "0.3.1",
    runtime: updater,
    timers,
  });
  try {
    await coordinator.start({ reconcile: false });
    expect(reconciliations).toBe(0);
    expect(timers.startup).toBeUndefined();
    await expect(coordinator.check()).rejects.toMatchObject({ code: "UpdateBusy" });
    await expect(coordinator.download()).rejects.toMatchObject({ code: "UpdateBusy" });
    const first = coordinator.completeInitialization();
    const duplicate = coordinator.completeInitialization();
    await coordinator.setAutomatic(true);
    expect(timers.startup).toBeUndefined();
    await expect(coordinator.check()).rejects.toMatchObject({ code: "UpdateBusy" });
    expect(updater.checks).toBe(0);
    expect(updater.downloads).toBe(0);
    finish();
    await Promise.all([first, duplicate]);
    expect(reconciliations).toBe(1);
    expect(coordinator.statusValue().transaction).toMatchObject({
      status: "confirmed",
      version: VERSION,
      hash: HASH,
    });
    expect(coordinator.statusValue().recoveryRequired).toBe(false);
    expect(timers.startup).toBeDefined();
    await coordinator.check();
    await eventually(() => coordinator.statusValue().phase === "ready");
    expect(updater.checks).toBe(1);
  } finally {
    finish();
    coordinator.stop();
    await rm(data, { recursive: true, force: true });
  }
});

for (const rejects of [false, true]) {
  test(`stopped startup cannot publish late reconciliation or schedule checks, rejects=${rejects}`, async () => {
    const data = await directory();
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const updater = runtime({
      reconcile: async () => {
        await gate;
        if (rejects) throw new Error("Synthetic late startup failure");
        return { status: "confirmed", version: VERSION, hash: HASH };
      },
    });
    const timers = new FakeTimers();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers,
    });
    await coordinator.start({ reconcile: false });
    const startup = coordinator.completeInitialization();
    let settled = false;
    coordinator.stop();
    const abandonment = coordinator.abandonPrepared().then(() => {
      settled = true;
    });
    const stopped = coordinator.statusValue();
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await startup;
      await abandonment;
      expect(coordinator.statusValue().transaction).toEqual(stopped.transaction);
      expect(coordinator.statusValue().recoveryRequired).toBe(false);
      expect(timers.startup).toBeUndefined();
      expect(timers.poll).toBeUndefined();
      expect(updater.checks).toBe(0);
    } finally {
      release();
      coordinator.stop();
      await startup;
      await abandonment;
      await rm(data, { recursive: true, force: true });
    }
  });
}

test("default-on scheduling checks after startup and automatically prepares an eligible update", async () => {
  const data = await directory();
  try {
    const timers = new FakeTimers();
    const updater = runtime();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers,
      startupDelayMs: 10,
      checkIntervalMs: 24 * 60 * 60_000,
      pollIntervalMs: 60 * 60_000,
    });
    expect((await coordinator.start()).automaticUpdates).toBe(true);
    expect(timers.startup).toBeDefined();
    timers.runStartup();
    await eventually(() => coordinator.statusValue().phase === "ready");
    expect(updater.checks).toBe(1);
    expect(updater.downloads).toBe(1);
    expect(coordinator.statusValue()).toMatchObject({
      phase: "ready",
      availableVersion: VERSION,
      readyVersion: VERSION,
      error: null,
    });
    timers.runPoll(24 * 60 * 60_000);
    await eventually(() => updater.checks === 1);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("automatic updates off still permits a manual check and requires an explicit download", async () => {
  const data = await directory();
  try {
    await writeFile(
      join(data, "updates.json"),
      JSON.stringify({ schema_version: 1, automaticUpdates: false }),
      { mode: 0o600 },
    );
    const timers = new FakeTimers();
    const updater = runtime();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers,
    });
    expect(await coordinator.start()).toMatchObject({ automaticUpdates: false, phase: "idle" });
    expect(timers.startup).toBeUndefined();
    expect(await coordinator.check()).toMatchObject({ phase: "available" });
    expect(updater.downloads).toBe(0);
    expect(await coordinator.download()).toMatchObject({ phase: "ready" });
    expect(updater.downloads).toBe(1);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("invalid preferences surface a preference error and suppress scheduling", async () => {
  const data = await directory();
  try {
    await writeFile(join(data, "updates.json"), '{"schema_version":1}', { mode: 0o600 });
    const timers = new FakeTimers();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: runtime(),
      timers,
    });
    expect(await coordinator.start()).toMatchObject({
      automaticUpdates: false,
      phase: "preference-error",
      preferenceError: expect.any(String),
    });
    expect(timers.startup).toBeUndefined();
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("single-flight check coalesces callers and late results after stop are ignored", async () => {
  const data = await directory();
  try {
    let release: (value: UpdateCheckResult) => void = () => {};
    const pending = new Promise<UpdateCheckResult>((resolve) => {
      release = resolve;
    });
    const updater = runtime({ check: () => pending });
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers: new FakeTimers(),
    });
    await coordinator.start();
    const first = coordinator.check();
    void coordinator.check();
    expect(updater.checks).toBe(1);
    expect(coordinator.statusValue().phase).toBe("checking");
    coordinator.stop();
    expect(updater.cancels).toBe(1);
    release({ available: true, version: VERSION, hash: HASH, currentVersion: "0.3.1" });
    expect((await first).phase).toBe("checking");
    expect(coordinator.statusValue().availableVersion).toBeNull();
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("sanitizes boundary failures and keeps retry state free of raw diagnostics", async () => {
  const data = await directory();
  try {
    const updater = runtime({
      check: async () => {
        throw new Error("private-network-detail");
      },
    });
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers: new FakeTimers(),
    });
    await coordinator.start();
    const status = await coordinator.check();
    expect(status.phase).toBe("error");
    expect(status.error).toBe("The update operation failed.");
    expect(JSON.stringify(status)).not.toContain("private-network-detail");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("disabled installation refuses restart before cleanup while enabled terminal handoff freezes the exact candidate", async () => {
  const data = await directory();
  try {
    const updater = runtime();
    const disabled = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers: new FakeTimers(),
    });
    await disabled.start();
    await disabled.check();
    await disabled.download();
    await expect(disabled.restartToUpdate(VERSION, HASH)).rejects.toBeInstanceOf(UpdatePolicyError);
    await expect(disabled.restartToUpdate(VERSION, HASH)).rejects.toMatchObject({
      code: "UpdateInstallationDisabled",
    });

    const accepted = terminal();
    const enabled = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installationEnabled: true,
      installedVersion: "0.3.1",
      runtime: updater,
      terminal: accepted,
      timers: new FakeTimers(),
    });
    await enabled.start();
    await enabled.check();
    await enabled.download();
    const status = await enabled.restartToUpdate(VERSION, HASH);
    expect(updater.revalidations).toBe(1);
    expect(accepted.calls).toBe(1);
    expect(status.phase).toBe("pending");
    expect(enabled.statusValue().phase).toBe("restarting");
    await expect(enabled.restartToUpdate("0.3.3", HASH)).rejects.toMatchObject({
      code: "UpdateNotReady",
    });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("setAutomatic writes the preference, stops new scheduling, and preserves the previous setting on write failure", async () => {
  const data = await directory();
  try {
    const timers = new FakeTimers();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: runtime(),
      timers,
    });
    await coordinator.start();
    expect(await coordinator.setAutomatic(false)).toMatchObject({ automaticUpdates: false });
    expect(timers.startup).toBeUndefined();
    expect(await coordinator.setAutomatic(true)).toMatchObject({ automaticUpdates: true });
    expect(timers.startup).toBeDefined();
    await rm(join(data, "updates.json"), { force: true });
    await mkdir(join(data, "updates.json"), { recursive: true, mode: 0o700 });
    const failed = await coordinator.setAutomatic(false);
    expect(failed.automaticUpdates).toBe(true);
    expect(failed.preferenceError).toContain("previous setting remains active");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

for (const enabled of [false, true]) {
  test(`published preference with uncertain durability controls current and restarted scheduling: ${enabled}`, async () => {
    const data = await directory();
    const timers = new FakeTimers();
    const updater = runtime();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers,
    });
    const restartTimers = new FakeTimers();
    const restarted = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: runtime(),
      timers: restartTimers,
    });
    try {
      await coordinator.start();
      await coordinator.setAutomatic(!enabled);
      const sync = fs.fsyncSync;
      let failures = 0;
      const syncMock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory()) {
          failures++;
          throw new Error("Synthetic directory synchronization refusal");
        }
        sync(fd);
      });
      try {
        expect(await coordinator.setAutomatic(enabled)).toMatchObject({
          automaticUpdates: enabled,
          phase: "idle",
          preferenceError: expect.stringContaining("durability could not be confirmed"),
        });
      } finally {
        syncMock.mockRestore();
      }
      expect(failures).toBe(1);
      expect(await readFile(join(data, "updates.json"), "utf8")).toBe(
        `${JSON.stringify({ schema_version: 1, automaticUpdates: enabled })}\n`,
      );
      expect(Boolean(timers.startup)).toBe(enabled);
      expect(Boolean(timers.poll)).toBe(enabled);
      expect(await restarted.start()).toMatchObject({
        automaticUpdates: enabled,
        preferenceError: null,
      });
      expect(Boolean(restartTimers.startup)).toBe(enabled);
      expect(Boolean(restartTimers.poll)).toBe(enabled);
      timers.runStartup();
      timers.runPoll(24 * 60 * 60_000);
      if (enabled) await eventually(() => coordinator.statusValue().phase === "ready");
      expect(updater.checks).toBe(enabled ? 1 : 0);
      expect(updater.downloads).toBe(enabled ? 1 : 0);
      expect(coordinator.statusValue().preferenceError).toContain(
        "durability could not be confirmed",
      );
      expect(await coordinator.setAutomatic(enabled)).toMatchObject({
        automaticUpdates: enabled,
        preferenceError: null,
      });
    } finally {
      coordinator.stop();
      restarted.stop();
      await rm(data, { recursive: true, force: true });
    }
  });
}

test("unverifiable publication disables scheduling until a successful preference retry", async () => {
  const data = await directory();
  const timers = new FakeTimers();
  const updater = runtime();
  const coordinator = new UpdaterCoordinator({
    dataDirectory: data,
    supported: true,
    installedVersion: "0.3.1",
    runtime: updater,
    timers,
  });
  try {
    await coordinator.start();
    expect(timers.startup).toBeDefined();
    const sync = fs.fsyncSync;
    let failures = 0;
    const syncMock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        failures++;
        fs.truncateSync(join(data, "updates.json"), 0);
        throw new Error("Synthetic publication refusal");
      }
      sync(fd);
    });
    try {
      expect(await coordinator.setAutomatic(true)).toMatchObject({
        automaticUpdates: false,
        phase: "preference-error",
        preferenceError: expect.stringContaining("current value could not be verified"),
      });
    } finally {
      syncMock.mockRestore();
    }
    expect(failures).toBe(1);
    expect(timers.startup).toBeUndefined();
    expect(timers.poll).toBeUndefined();
    timers.runStartup();
    timers.runPoll(24 * 60 * 60_000);
    expect(updater.checks).toBe(0);
    expect(await coordinator.setAutomatic(true)).toMatchObject({
      automaticUpdates: true,
      phase: "idle",
      preferenceError: null,
    });
    expect(timers.startup).toBeDefined();
    expect(timers.poll).toBeDefined();
  } finally {
    coordinator.stop();
    await rm(data, { recursive: true, force: true });
  }
});

for (const phase of ["available", "ready", "error"] as const) {
  test(`an unverifiable preference does not erase update work in phase ${phase}`, async () => {
    const data = await directory();
    const updater = runtime();
    const accepted = terminal();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installationEnabled: true,
      installedVersion: "0.3.1",
      runtime: updater,
      terminal: accepted,
      timers: new FakeTimers(),
    });
    try {
      await coordinator.start();
      await coordinator.setAutomatic(false);
      await coordinator.check();
      if (phase !== "available") await coordinator.download();
      if (phase === "error") coordinator.markHandoffFailed("Synthetic retryable handoff failure");
      const before = coordinator.statusValue();
      expect(before.phase).toBe(phase);
      const sync = fs.fsyncSync;
      let failures = 0;
      const syncMock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory()) {
          failures++;
          fs.truncateSync(join(data, "updates.json"), 0);
          throw new Error("Synthetic publication refusal");
        }
        sync(fd);
      });
      try {
        expect(await coordinator.setAutomatic(true)).toEqual({
          ...before,
          automaticUpdates: false,
          preferenceError: expect.stringContaining("current value could not be verified"),
        });
      } finally {
        syncMock.mockRestore();
      }
      expect(failures).toBe(1);
      expect(await coordinator.setAutomatic(false)).toEqual(before);
      if (phase === "available") await coordinator.download();
      expect(await coordinator.restartToUpdate(VERSION, HASH)).toMatchObject({ phase: "pending" });
      expect(accepted.calls).toBe(1);
      expect(updater.checks).toBe(1);
      expect(updater.downloads).toBe(1);
      expect(updater.revalidations).toBe(1);
    } finally {
      coordinator.stop();
      await rm(data, { recursive: true, force: true });
    }
  });
}

test("a failed handoff remains retryable with the same frozen candidate", async () => {
  const data = await directory();
  try {
    const updater = runtime();
    const accepted = terminal();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installationEnabled: true,
      installedVersion: "0.3.1",
      runtime: updater,
      terminal: accepted,
      timers: new FakeTimers(),
    });
    await coordinator.start();
    await coordinator.check();
    await coordinator.download();
    coordinator.markHandoffFailed("The update could not be handed to the installer.");
    expect(coordinator.statusValue()).toMatchObject({
      phase: "error",
      readyVersion: VERSION,
      error: "The update could not be handed to the installer.",
    });
    await coordinator.restartToUpdate(VERSION, HASH);
    expect(accepted.calls).toBe(1);
    expect(updater.revalidations).toBe(1);
    expect(coordinator.statusValue().phase).toBe("restarting");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("polling performs at most one overdue automatic check and does not replay intervals", async () => {
  const data = await directory();
  try {
    const timers = new FakeTimers();
    const updater = runtime({
      check: async () => ({ available: false, version: null, hash: null, currentVersion: "0.3.1" }),
    });
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers,
      startupDelayMs: 10,
      checkIntervalMs: 24 * 60 * 60_000,
      pollIntervalMs: 60 * 60_000,
    });
    await coordinator.start();
    timers.runStartup();
    await eventually(() => updater.checks === 1 && coordinator.statusValue().phase === "idle");
    timers.runPoll(60 * 60_000);
    expect(updater.checks).toBe(1);
    timers.runPoll(24 * 60 * 60_000);
    await eventually(() => updater.checks === 2);
    timers.runPoll(60 * 60_000);
    expect(updater.checks).toBe(2);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("independently rejects a runtime offer that is not a higher stable version", async () => {
  const data = await directory();
  try {
    const updater = runtime({
      check: async () => ({
        available: true,
        version: "0.3.1",
        hash: HASH,
        currentVersion: "0.3.1",
      }),
    });
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers: new FakeTimers(),
    });
    await coordinator.start();
    expect(await coordinator.check()).toMatchObject({
      phase: "error",
      error: "The offered update version is not eligible.",
      availableVersion: null,
    });
    expect(updater.downloads).toBe(0);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("startup reconciliation exposes recovery-required state and suppresses new update work", async () => {
  const data = await directory();
  try {
    const timers = new FakeTimers();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: runtime({
        reconcile: async () => ({
          status: "recovery-required",
          recoveryPath: "/synthetic/previous.app",
          message: "Recovery is required.",
        }),
      }),
      timers,
    });
    const status = await coordinator.start();
    expect(status).toMatchObject({
      phase: "error",
      recoveryRequired: true,
      recoveryPath: "/synthetic/previous.app",
      automaticUpdates: true,
    });
    expect(timers.startup).toBeUndefined();
    await expect(coordinator.check()).rejects.toMatchObject({ code: "UpdateRecoveryRequired" });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("download is refused while a check is in flight and after shutdown admission", async () => {
  const data = await directory();
  try {
    let releaseCheck: (result: UpdateCheckResult) => void = () => {};
    let checkCalls = 0;
    const pending = new Promise<UpdateCheckResult>((resolve) => {
      releaseCheck = resolve;
    });
    await (await import("node:fs/promises")).writeFile(
      join(data, "updates.json"),
      JSON.stringify({ schema_version: 1, automaticUpdates: false }),
      { mode: 0o600 },
    );
    const updater = runtime();
    updater.checkForUpdate = async () => {
      if (++checkCalls === 1)
        return { available: true, version: VERSION, hash: HASH, currentVersion: "0.3.1" };
      return pending;
    };
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installedVersion: "0.3.1",
      runtime: updater,
      timers: new FakeTimers(),
    });
    await coordinator.start();
    await coordinator.check();
    const inFlight = coordinator.check();
    await expect(coordinator.download()).rejects.toMatchObject({ code: "UpdateBusy" });
    releaseCheck({ available: false, version: null, hash: null, currentVersion: "0.3.1" });
    await inFlight;
    expect(updater.downloads).toBe(0);
    coordinator.stop();
    await expect(coordinator.check()).rejects.toMatchObject({ code: "UpdateShutdown" });
    await expect(coordinator.download()).rejects.toMatchObject({ code: "UpdateShutdown" });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a failed restart revalidation cancels its reservation but retains preparation for retry", async () => {
  const data = await directory();
  try {
    const updater = runtime();
    updater.revalidate = async () => {
      throw new Error("private-revalidation-detail");
    };
    const accepted = terminal();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installationEnabled: true,
      installedVersion: "0.3.1",
      runtime: updater,
      terminal: accepted,
      timers: new FakeTimers(),
    });
    await coordinator.start();
    await coordinator.check();
    await coordinator.download();
    const reserved = coordinator.beginRestart(VERSION, HASH);
    await expect(coordinator.restartToUpdate(VERSION, HASH)).rejects.toMatchObject({
      code: "UpdateNotReady",
    });
    expect(accepted.cancels).toBe(1);
    expect(accepted.calls).toBe(0);
    expect(updater.abandons).toBe(0);
    expect(coordinator.statusValue()).toMatchObject({
      phase: "error",
      attemptId: null,
      readyVersion: VERSION,
    });
    expect(JSON.stringify(coordinator.statusValue())).not.toContain("private-revalidation");
    expect(reserved.id).toBeGreaterThan(0);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("restart reserves one identity before queueing and retains it through delayed preflight and refused actions", async () => {
  const data = await directory();
  try {
    let release: () => void = () => {};
    let started = false;
    const updater = runtime();
    updater.revalidate = async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const accepted = terminal();
    const coordinator = new UpdaterCoordinator({
      dataDirectory: data,
      supported: true,
      installationEnabled: true,
      installedVersion: "0.3.1",
      runtime: updater,
      terminal: accepted,
      timers: new FakeTimers(),
    });
    await coordinator.start();
    await coordinator.check();
    await coordinator.download();
    const reserved = coordinator.beginRestart(VERSION, HASH);
    expect(coordinator.statusValue()).toMatchObject({
      phase: "restarting",
      attemptId: reserved.id,
      readyVersion: VERSION,
    });
    expect(coordinator.beginRestart(VERSION, HASH).id).toBe(reserved.id);
    await expect(coordinator.check()).rejects.toMatchObject({ code: "UpdateBusy" });
    await expect(coordinator.download()).rejects.toMatchObject({ code: "UpdateBusy" });
    const pending = coordinator.restartToUpdate(VERSION, HASH);
    expect(started).toBe(true);
    await expect(coordinator.check()).rejects.toMatchObject({ code: "UpdateBusy" });
    await expect(coordinator.download()).rejects.toMatchObject({ code: "UpdateBusy" });
    expect(coordinator.statusValue()).toMatchObject({
      phase: "restarting",
      attemptId: reserved.id,
      readyVersion: VERSION,
    });
    release();
    await pending;
    expect(accepted.calls).toBe(1);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
