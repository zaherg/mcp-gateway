import { test as bunTest, expect } from "bun:test";

// Transaction integration acquires the macOS kernel guard; policy tests remain portable.
const test = bunTest.skipIf(process.platform !== "darwin");

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FrozenCandidate } from "../../src/main/updater/candidate";
import { acquireKernelGuard } from "../../src/main/updater/kernel-guard";
import type { ExactHelperInspection } from "../../src/main/updater/process-inspector";
import { captureRegisteredGroup } from "../../src/main/updater/registered-group";
import {
  type EarlyTerminalResultBinding,
  type ExpectedNativePlan,
  type JournalIdentity,
  nativeHelperPath,
  nativePlanPath,
  nativeResultPath,
  type ObservedPlanBinding,
  readLease,
  reconcileTransaction,
  TransactionLease,
  TransactionLeaseError,
  type UnarmedEvidence,
  type UpdateAttempt,
} from "../../src/main/updater/transaction";

const HASH = "target123456";
const VERSION = "0.3.1";
const ID = "0123456789abcdef0123456789abcdef";
const OLD_ID = "abcdefabcdefabcdefabcdefabcdefab";

type Fixture = Readonly<{
  root: string;
  home: string;
  channel: string;
  app: string;
  data: string;
  temporary: string;
}>;

function candidate(): FrozenCandidate {
  return {
    schema_version: 1,
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    version: VERSION,
    hash: HASH,
    artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
    prepared_path: "/synthetic/prepared.json",
    prepared_sha256: "a".repeat(64),
    retained_tar_path: "/synthetic/target.tar",
    archive_sha256: "b".repeat(64),
    archive_bytes: 1,
    frozen_at: "2026-11-03T00:00:00.000Z",
  };
}

function attempt(_file: Fixture, id = 7, signal = new AbortController().signal): UpdateAttempt {
  return { id, candidate: candidate(), signal };
}

function expected(file: Fixture, overrides: Partial<ExpectedNativePlan> = {}): ExpectedNativePlan {
  return {
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    platform: "macos",
    arch: "arm64",
    version: VERSION,
    hash: HASH,
    channelRoot: file.channel,
    appBundlePath: file.app,
    retainedTarPath: candidate().retained_tar_path,
    parentPid: process.pid,
    physicalTemporaryDirectory: file.temporary,
    ...overrides,
  };
}

async function fixture(): Promise<Fixture> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-transaction-"));
  const home = join(root, "home");
  const channel = join(home, "Library/Application Support/dev.srvr.mcpgateway/stable");
  const app = join(home, "Applications/MCP Gateway.app");
  const data = join(root, "data");
  const temporary = join(root, "tmp");
  await mkdir(channel, { recursive: true, mode: 0o700 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  await mkdir(join(app, "Contents/Resources"), { recursive: true });
  await writeFile(
    join(app, "Contents/Resources/version.json"),
    JSON.stringify({ version: VERSION, hash: HASH }),
    { mode: 0o600 },
  );
  return { root, home, channel, app, data, temporary };
}

async function preparedLease(file: Fixture): Promise<TransactionLease> {
  const lease = await TransactionLease.acquire({
    channelRoot: file.channel,
    dataDirectory: file.data,
    appBundlePath: file.app,
  });
  await lease.markPrepared(candidate(), "/synthetic/previous.app");
  return lease;
}

async function preflightLease(
  file: Fixture,
  existingNativeIds: readonly string[] = [],
  id = 7,
): Promise<{ lease: TransactionLease; identity: JournalIdentity }> {
  const lease = await preparedLease(file);
  const prepared = await lease.prepareHandoff(attempt(file, id), expected(file), existingNativeIds);
  return { lease, identity: prepared.identity };
}

function observedBinding(
  file: Fixture,
  transactionId = ID,
  overrides: Partial<ObservedPlanBinding> = {},
): ObservedPlanBinding {
  return {
    evidence: "observed-plan",
    transactionId,
    planPath: nativePlanPath(file.channel, transactionId),
    resultPath: nativeResultPath(file.channel, transactionId),
    helperPath: nativeHelperPath(file.temporary, transactionId),
    plan: expected(file),
    ...overrides,
  };
}

function earlyBinding(
  file: Fixture,
  transactionId = ID,
  overrides: Partial<EarlyTerminalResultBinding> = {},
): EarlyTerminalResultBinding {
  return {
    evidence: "early-terminal-result",
    transactionId,
    resultPath: nativeResultPath(file.channel, transactionId),
    helperPath: nativeHelperPath(file.temporary, transactionId),
    ...overrides,
  };
}

function resultDocument(
  transactionId = ID,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    transaction_id: transactionId,
    success: true,
    phase: "complete",
    message: "Update applied successfully.",
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    version: VERSION,
    hash: HASH,
    ...overrides,
  };
}

async function writeResult(
  file: Fixture,
  document: Record<string, unknown>,
  transactionId = String(document.transaction_id),
  mode = 0o644,
): Promise<string> {
  const path = nativeResultPath(file.channel, transactionId);
  await writeFile(path, JSON.stringify(document), { mode });
  await chmod(path, mode);
  return path;
}

async function committedLease(
  file: Fixture,
  existingNativeIds: readonly string[] = [],
): Promise<TransactionLease> {
  const { lease, identity } = await preflightLease(file, existingNativeIds);
  lease.armHandoffSync(identity);
  lease.bindNativeSync(identity, observedBinding(file));
  lease.releaseGuard();
  return lease;
}

const absentInspection = async (): Promise<ExactHelperInspection> => ({
  status: "absent",
  pids: [],
});

function running(file: Fixture) {
  return { version: VERSION, hash: HASH, appBundlePath: file.app };
}

async function cleanup(file: Fixture): Promise<void> {
  await rm(file.root, { recursive: true, force: true });
}

test("one exclusive transaction lease blocks a second application writer", async () => {
  const file = await fixture();
  try {
    const first = await TransactionLease.acquire({
      channelRoot: file.channel,
      dataDirectory: file.data,
      appBundlePath: file.app,
    });
    await expect(
      TransactionLease.acquire({
        channelRoot: file.channel,
        dataDirectory: file.data,
        appBundlePath: file.app,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    await first.releaseUncommitted();
    const next = await TransactionLease.acquire({
      channelRoot: file.channel,
      dataDirectory: file.data,
      appBundlePath: file.app,
    });
    await next.releaseUncommitted();
  } finally {
    await cleanup(file);
  }
});

test("prepares the exact approved candidate and a bounded before-call ID set", async () => {
  const file = await fixture();
  try {
    const lease = await preparedLease(file);
    await expect(
      lease.prepareHandoff(attempt(file, 7), expected(file, { hash: "wrong123456" }), []),
    ).rejects.toMatchObject({ code: "candidate" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      lease.prepareHandoff(attempt(file, 7, aborted.signal), expected(file), []),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      lease.prepareHandoff(
        attempt(file, 7),
        expected(file, { channelRoot: join(file.root, "other") }),
        [],
      ),
    ).rejects.toMatchObject({ code: "candidate" });
    await expect(
      lease.prepareHandoff(attempt(file, 7), expected(file), [OLD_ID, OLD_ID]),
    ).rejects.toBeInstanceOf(TransactionLeaseError);
    const prepared = await lease.prepareHandoff(attempt(file, 7), expected(file), [ID, OLD_ID]);
    expect(prepared.identity).toEqual({ nonce: lease.snapshot().lease_id, attemptId: 7 });
    expect(prepared.existingNativeIds).toEqual([ID, OLD_ID].sort());
    expect(lease.snapshot()).toMatchObject({
      phase: "preflight",
      attempt_id: 7,
      expected_native: expected(file),
      existing_native_ids: [ID, OLD_ID].sort(),
      binding: null,
    });
    expect((await readLease(file.channel))?.phase).toBe("preflight");
    await expect(
      lease.prepareHandoff(attempt(file, 7), expected(file), [ID, OLD_ID]),
    ).resolves.toBeDefined();
    await expect(
      lease.prepareHandoff(attempt(file, 8), expected(file), [ID, OLD_ID]),
    ).rejects.toMatchObject({ code: "handoff" });
    await lease.releaseUncommitted();
  } finally {
    await cleanup(file);
  }
});

test("arming requires the held guard, exact nonce/attempt and preflight state", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    const reconstructed = new TransactionLease(file.channel, file.data, lease.snapshot());
    expect(() => reconstructed.armHandoffSync(identity)).toThrow(TransactionLeaseError);
    expect(() => lease.armHandoffSync({ ...identity, nonce: OLD_ID })).toThrow(
      TransactionLeaseError,
    );
    expect(() => lease.armHandoffSync({ ...identity, attemptId: 9 })).toThrow(
      TransactionLeaseError,
    );
    lease.armHandoffSync(identity);
    expect(lease.snapshot().phase).toBe("arming");
    expect((await readLease(file.channel))?.phase).toBe("arming");
    expect(() => lease.armHandoffSync(identity)).toThrow(TransactionLeaseError);
    lease.releaseGuard();
    expect((await readLease(file.channel))?.phase).toBe("arming");
  } finally {
    await cleanup(file);
  }
});

test("binding persists the exact observed native transaction before returning", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file, [OLD_ID]);
    lease.armHandoffSync(identity);
    expect(() => lease.bindNativeSync(identity, observedBinding(file, OLD_ID))).toThrow(
      TransactionLeaseError,
    );
    expect(lease.snapshot().phase).toBe("arming");
    expect(() =>
      lease.bindNativeSync(identity, {
        ...observedBinding(file),
        resultPath: nativeResultPath(file.channel, OLD_ID),
      }),
    ).toThrow(TransactionLeaseError);
    expect(() =>
      lease.bindNativeSync(identity, {
        ...observedBinding(file),
        plan: expected(file, { version: "0.3.2" }),
      }),
    ).toThrow(TransactionLeaseError);
    expect(lease.snapshot()).toMatchObject({ phase: "arming", binding: null });
    lease.bindNativeSync(identity, observedBinding(file));
    expect(lease.snapshot()).toMatchObject({
      phase: "handed-off",
      binding: observedBinding(file),
    });
    expect((await readLease(file.channel))?.binding).toEqual(observedBinding(file));
    expect(() => lease.bindNativeSync(identity, observedBinding(file))).toThrow(
      TransactionLeaseError,
    );
    lease.releaseGuard();
  } finally {
    await cleanup(file);
  }
});

test("a binding persistence failure keeps the durable arming record", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    lease.armHandoffSync(identity);
    const directory = join(file.channel, ".mcp-gateway-update-transaction");
    await chmod(directory, 0o500);
    try {
      expect(() => lease.bindNativeSync(identity, observedBinding(file))).toThrow();
    } finally {
      await chmod(directory, 0o700);
    }
    expect(lease.snapshot()).toMatchObject({ phase: "arming", binding: null });
    expect((await readLease(file.channel))?.phase).toBe("arming");
    lease.releaseGuard();
  } finally {
    await cleanup(file);
  }
});

test("limited early terminal-result binding validates filename, document and candidate", async () => {
  const file = await fixture();
  try {
    const first = await preflightLease(file);
    first.lease.armHandoffSync(first.identity);
    await writeResult(file, resultDocument(ID, { transaction_id: OLD_ID }), ID);
    expect(() => first.lease.bindNativeSync(first.identity, earlyBinding(file))).toThrow(
      TransactionLeaseError,
    );
    await writeResult(file, resultDocument(ID, { success: false, phase: "complete" }));
    expect(() => first.lease.bindNativeSync(first.identity, earlyBinding(file))).toThrow(
      TransactionLeaseError,
    );
    await writeResult(file, resultDocument(ID, { success: false, phase: "validating" }));
    first.lease.bindNativeSync(first.identity, earlyBinding(file));
    const journal = await readLease(file.channel);
    expect(journal?.phase).toBe("handed-off");
    expect(journal?.binding?.evidence).toBe("early-terminal-result");
    expect(journal?.binding).not.toHaveProperty("plan");
    first.lease.releaseGuard();
  } finally {
    await cleanup(file);
  }
});

test("unarmed retirement requires issued proof and settled owned work", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    expect(() =>
      lease.proveUnarmed(identity, {
        reason: "vetoed",
        approvalOffered: false,
        applyingObserved: false,
        bindingObserved: false,
      }),
    ).toThrow(TransactionLeaseError);
    lease.armHandoffSync(identity);
    expect(() =>
      lease.proveUnarmed(identity, {
        reason: "vetoed",
        approvalOffered: true,
        applyingObserved: true,
        bindingObserved: false,
      }),
    ).toThrow(TransactionLeaseError);
    const evidence = lease.proveUnarmed(identity, {
      reason: "vetoed",
      approvalOffered: true,
      applyingObserved: false,
      bindingObserved: false,
    });
    const fabricated: UnarmedEvidence = {
      kind: "unarmed",
      reason: "vetoed",
      nonce: identity.nonce,
      attemptId: identity.attemptId,
      approvalOffered: true,
      applyingObserved: false,
      bindingObserved: false,
    };
    await expect(lease.retireUnarmed(identity, fabricated)).rejects.toThrow(TransactionLeaseError);
    const gate = deferred();
    const tracked = lease.trackOwnedWork(gate.promise);
    const retirement = lease.retireUnarmed(identity, evidence);
    await Bun.sleep(20);
    expect(await readLease(file.channel)).toBeDefined();
    gate.resolve();
    await Promise.all([tracked, retirement]);
    expect(await readLease(file.channel)).toBeUndefined();
  } finally {
    await cleanup(file);
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, resolve: () => release?.() };
}

test("unarmed retirement retains the journal when owned cleanup failed", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    lease.armHandoffSync(identity);
    const evidence = lease.proveUnarmed(identity, {
      reason: "cancelled",
      approvalOffered: false,
      applyingObserved: false,
      bindingObserved: false,
    });
    lease.trackOwnedWork(Promise.reject(new Error("cleanup failed")));
    await expect(lease.retireUnarmed(identity, evidence)).rejects.toMatchObject({
      code: "state",
    });
    expect((await readLease(file.channel))?.phase).toBe("arming");
  } finally {
    await cleanup(file);
  }
});

test("unarmed retirement refuses a newly created native transaction", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    lease.armHandoffSync(identity);
    const evidence = lease.proveUnarmed(identity, {
      reason: "cancelled",
      approvalOffered: false,
      applyingObserved: false,
      bindingObserved: false,
    });
    await writeFile(nativePlanPath(file.channel, OLD_ID), "{}", { mode: 0o600 });
    await expect(lease.retireUnarmed(identity, evidence)).rejects.toMatchObject({
      code: "handoff",
    });
    expect((await readLease(file.channel))?.phase).toBe("arming");
  } finally {
    await cleanup(file);
  }
});

test("uncommitted release refuses committed embargos and never removes them", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    lease.armHandoffSync(identity);
    await expect(lease.releaseUncommitted()).rejects.toMatchObject({ code: "handoff" });
    expect((await readLease(file.channel))?.phase).toBe("arming");
  } finally {
    await cleanup(file);
  }
});

test("reconciled retirement refuses a structurally fabricated completion proof", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    lease.armHandoffSync(identity);
    lease.bindNativeSync(identity, observedBinding(file));
    const fabricated = {
      kind: "reconciled-completion" as const,
      nonce: identity.nonce,
      attemptId: identity.attemptId,
      transactionId: ID,
      resultPath: nativeResultPath(file.channel, ID),
      helperPath: nativeHelperPath(file.temporary, ID),
      planPath: nativePlanPath(file.channel, ID),
      success: true,
      target: { appBundlePath: file.app, version: VERSION, hash: HASH },
    };
    await expect(lease.retireReconciled(fabricated)).rejects.toBeInstanceOf(TransactionLeaseError);
    expect((await readLease(file.channel))?.phase).toBe("handed-off");
  } finally {
    await cleanup(file);
  }
});

test("guard-only release preserves the durable journal for another writer", async () => {
  const file = await fixture();
  try {
    const { lease, identity } = await preflightLease(file);
    lease.armHandoffSync(identity);
    await writeResult(file, resultDocument());
    lease.releaseGuard();
    const journal = await readLease(file.channel);
    expect(journal).toMatchObject({ phase: "arming", binding: null });
    const reconciled = await reconcileTransaction({
      channelRoot: file.channel,
      dataDirectory: file.data,
      running: running(file),
      inspectHelper: absentInspection,
    });
    expect(reconciled.status).toBe("recovery-required");
    expect(await readLease(file.channel)).toBeDefined();
  } finally {
    await cleanup(file);
  }
});

test("reconciles only the exact bound result after helper and plan are finished", async () => {
  const file = await fixture();
  try {
    await committedLease(file);
    await writeResult(file, resultDocument());
    await writeResult(file, resultDocument(OLD_ID), OLD_ID);
    const confirmed = await reconcileTransaction({
      channelRoot: file.channel,
      dataDirectory: file.data,
      running: running(file),
      inspectHelper: absentInspection,
    });
    expect(confirmed).toMatchObject({ status: "confirmed", version: VERSION, hash: HASH });
    expect(await readLease(file.channel)).toBeUndefined();
    expect(
      (
        await reconcileTransaction({
          channelRoot: file.channel,
          dataDirectory: file.data,
          inspectHelper: absentInspection,
        })
      ).status,
    ).toBe("none");
  } finally {
    await cleanup(file);
  }
});

test("a terminal failure result retires only after exact finished-helper evidence", async () => {
  const file = await fixture();
  try {
    await committedLease(file);
    await writeResult(file, resultDocument(ID, { success: false, phase: "swapping" }));
    const failed = await reconcileTransaction({
      channelRoot: file.channel,
      dataDirectory: file.data,
      running: { version: "0.3.0", hash: "current1234", appBundlePath: file.app },
      inspectHelper: absentInspection,
    });
    expect(failed).toMatchObject({
      status: "failed",
      recoveryPath: "/synthetic/previous.app",
      version: VERSION,
      hash: HASH,
    });
    expect(await readLease(file.channel)).toBeUndefined();
  } finally {
    await cleanup(file);
  }
});

test("missing, mismatched or inconsistent bound results fail closed", async () => {
  const scenarios: Array<{
    name: string;
    prepare: (file: Fixture) => Promise<void>;
  }> = [
    { name: "missing exact result", prepare: async () => undefined },
    {
      name: "document ID mismatch",
      prepare: async (file) => {
        await writeResult(file, resultDocument(OLD_ID));
      },
    },
    {
      name: "unrelated older result only",
      prepare: async (file) => {
        await writeResult(file, resultDocument(OLD_ID), OLD_ID);
      },
    },
    {
      name: "success with non-terminal phase",
      prepare: async (file) => {
        await writeResult(file, resultDocument(ID, { phase: "launching" }));
      },
    },
    {
      name: "failure with complete phase",
      prepare: async (file) => {
        await writeResult(file, resultDocument(ID, { success: false }));
      },
    },
    {
      name: "group-writable result",
      prepare: async (file) => {
        await writeResult(file, resultDocument(), ID, 0o666);
      },
    },
  ];
  for (const scenario of scenarios) {
    const file = await fixture();
    try {
      await committedLease(file);
      await scenario.prepare(file);
      const outcome = await reconcileTransaction({
        channelRoot: file.channel,
        dataDirectory: file.data,
        running: running(file),
        inspectHelper: absentInspection,
      });
      expect({ name: scenario.name, status: outcome.status }).toEqual({
        name: scenario.name,
        status: "recovery-required",
      });
      expect(await readLease(file.channel)).toBeDefined();
    } finally {
      await cleanup(file);
    }
  }
});

test("a journal with altered native paths is not trusted at reconciliation", async () => {
  const file = await fixture();
  try {
    await committedLease(file);
    const journal = await readLease(file.channel);
    if (!journal?.binding) throw new Error("Missing binding fixture");
    await writeResult(file, resultDocument(ID));
    await writeResult(file, resultDocument(OLD_ID), OLD_ID);
    const tampered = {
      ...journal,
      binding: { ...journal.binding, resultPath: nativeResultPath(file.channel, OLD_ID) },
    };
    await writeFile(
      join(file.channel, ".mcp-gateway-update-transaction/lease.json"),
      `${JSON.stringify(tampered)}\n`,
      { mode: 0o600 },
    );
    const outcome = await reconcileTransaction({
      channelRoot: file.channel,
      dataDirectory: file.data,
      running: running(file),
      inspectHelper: absentInspection,
    });
    expect(outcome.status).toBe("recovery-required");
    expect(await readLease(file.channel)).toMatchObject({ phase: "handed-off" });
  } finally {
    await cleanup(file);
  }
});

test("an unfinished helper or plan preserves the durable handoff embargo", async () => {
  const planPresent = await fixture();
  try {
    await committedLease(planPresent);
    await writeResult(planPresent, resultDocument());
    await writeFile(nativePlanPath(planPresent.channel, ID), "{}", { mode: 0o600 });
    expect(
      (
        await reconcileTransaction({
          channelRoot: planPresent.channel,
          dataDirectory: planPresent.data,
          running: running(planPresent),
          inspectHelper: absentInspection,
        })
      ).status,
    ).toBe("recovery-required");
    expect(await readLease(planPresent.channel)).toBeDefined();
  } finally {
    await cleanup(planPresent);
  }

  const helperPresent = await fixture();
  try {
    await committedLease(helperPresent);
    await writeResult(helperPresent, resultDocument());
    await writeFile(nativeHelperPath(helperPresent.temporary, ID), "", { mode: 0o700 });
    expect(
      (
        await reconcileTransaction({
          channelRoot: helperPresent.channel,
          dataDirectory: helperPresent.data,
          running: running(helperPresent),
          inspectHelper: absentInspection,
        })
      ).status,
    ).toBe("recovery-required");
    expect(await readLease(helperPresent.channel)).toBeDefined();
  } finally {
    await cleanup(helperPresent);
  }

  const liveHelper = await fixture();
  try {
    await committedLease(liveHelper);
    await writeResult(liveHelper, resultDocument());
    const alive = async (): Promise<ExactHelperInspection> => ({
      status: "alive",
      pids: [123],
    });
    expect(
      (
        await reconcileTransaction({
          channelRoot: liveHelper.channel,
          dataDirectory: liveHelper.data,
          running: running(liveHelper),
          inspectHelper: alive,
        })
      ).status,
    ).toBe("recovery-required");
    expect(await readLease(liveHelper.channel)).toBeDefined();
  } finally {
    await cleanup(liveHelper);
  }
});

test("a different running app copy or version does not confirm or retire", async () => {
  for (const runningIdentity of [
    { version: VERSION, hash: HASH, appBundlePath: "/synthetic/other.app" },
    { version: "0.3.0", hash: HASH, appBundlePath: "" },
    { version: VERSION, hash: "other123456", appBundlePath: "" },
  ]) {
    const file = await fixture();
    try {
      await committedLease(file);
      await writeResult(file, resultDocument());
      const outcome = await reconcileTransaction({
        channelRoot: file.channel,
        dataDirectory: file.data,
        running: {
          version: runningIdentity.version,
          hash: runningIdentity.hash,
          appBundlePath: runningIdentity.appBundlePath || file.app,
        },
        inspectHelper: absentInspection,
      });
      expect(outcome.status).toBe("unconfirmed");
      expect(await readLease(file.channel)).toBeDefined();
    } finally {
      await cleanup(file);
    }
  }
});

test("a live prepared owner is never reconciled away by an unrelated result", async () => {
  const file = await fixture();
  try {
    const lease = await preparedLease(file);
    await writeResult(file, resultDocument());
    lease.releaseGuard();
    const outcome = await reconcileTransaction({
      channelRoot: file.channel,
      dataDirectory: file.data,
      running: running(file),
      inspectHelper: absentInspection,
    });
    expect(outcome.status).toBe("recovery-required");
    expect((await readLease(file.channel))?.phase).toBe("prepared");
  } finally {
    await cleanup(file);
  }
});

test("a guard held by a live owner blocks reconciliation", async () => {
  const file = await fixture();
  try {
    await committedLease(file);
    const holder = await TransactionLease.acquire({
      channelRoot: file.channel,
      dataDirectory: file.data,
      appBundlePath: file.app,
    }).catch(() => undefined);
    expect(holder).toBeUndefined();
    const blocking = await leaseGuardForTest(file);
    expect(
      (
        await reconcileTransaction({
          channelRoot: file.channel,
          dataDirectory: file.data,
          running: running(file),
          inspectHelper: absentInspection,
        })
      ).status,
    ).toBe("recovery-required");
    blocking.releaseGuard();
    expect((await readLease(file.channel))?.phase).toBe("handed-off");
  } finally {
    await cleanup(file);
  }
});

async function leaseGuardForTest(file: Fixture): Promise<TransactionLease> {
  const guard = await acquireKernelGuard(file.channel);
  const journal = await readLease(file.channel);
  if (!journal) throw new Error("Missing journal fixture");
  return new TransactionLease(file.channel, file.data, journal, guard);
}

test("malformed journals fail closed without deleting the record", async () => {
  const file = await fixture();
  try {
    await committedLease(file);
    await writeFile(join(file.channel, ".mcp-gateway-update-transaction/lease.json"), "{}", {
      mode: 0o600,
    });
    const outcome = await reconcileTransaction({
      channelRoot: file.channel,
      dataDirectory: file.data,
      running: running(file),
      inspectHelper: absentInspection,
    });
    expect(outcome.status).toBe("recovery-required");
    expect(
      await readFile(join(file.channel, ".mcp-gateway-update-transaction/lease.json"), "utf8"),
    ).toBe("{}");
  } finally {
    await cleanup(file);
  }
});

for (const failPersistence of [false, true]) {
  test(`preparation durably settles a previously registered exited worker (write refusal: ${failPersistence})`, async () => {
    const file = await fixture();
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const journalDirectory = join(file.channel, ".mcp-gateway-update-transaction");
    let lease: TransactionLease | undefined;
    let childClosed = false;
    try {
      lease = await TransactionLease.acquire({
        channelRoot: file.channel,
        dataDirectory: file.data,
        appBundlePath: file.app,
      });
      lease.registerWorkerGroupSync(
        await captureRegisteredGroup({
          leaderPid: child.pid,
          helperPath: file.app,
          planPath: join(file.root, "worker-result.json"),
        }),
      );
      lease.markWorkerGrantedSync();
      await expect(lease.assertWorkerSettled()).rejects.toMatchObject({ code: "state" });
      process.kill(-child.pid, "SIGKILL");
      await child.exited;
      childClosed = true;
      if (failPersistence) {
        await chmod(journalDirectory, 0o500);
        await expect(lease.markPrepared(candidate(), null)).rejects.toMatchObject({
          code: "state",
        });
        expect((await readLease(file.channel))?.phase).toBe("operation");
        await chmod(journalDirectory, 0o700);
      }
      await lease.markPrepared(candidate(), null);
      expect(lease.snapshot()).toMatchObject({
        registered_group: null,
        worker_granted: false,
        phase: "prepared",
      });
      expect(await readLease(file.channel)).toMatchObject({
        registered_group: null,
        worker_granted: false,
      });
      await expect(lease.prepareHandoff(attempt(file), expected(file), [])).resolves.toBeDefined();
    } finally {
      if (!childClosed) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
      await chmod(journalDirectory, 0o700);
      lease?.releaseGuard();
      await cleanup(file);
    }
  });
}

test("a live registered worker group blocks journal retirement", async () => {
  const file = await fixture();
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  try {
    const lease = await preparedLease(file);
    const group = await captureRegisteredGroup({
      leaderPid: child.pid,
      helperPath: file.app,
      planPath: join(file.root, "worker-result.json"),
    });
    lease.registerWorkerGroupSync(group);
    expect(lease.snapshot()).toMatchObject({ registered_group: group, worker_granted: false });
    lease.markWorkerGrantedSync();
    await expect(lease.releaseUncommitted()).rejects.toMatchObject({ code: "state" });
    expect((await readLease(file.channel))?.registered_group).toEqual(group);
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await child.exited;
    await cleanup(file);
  }
});

test("abandoned prepared cleanup refuses candidates symlinks and retains external bytes and journal", async () => {
  const file = await fixture();
  try {
    await exitedOwner(file, "prepared");
    const journal = await readLease(file.channel);
    const target = join(file.root, "unrelated");
    await mkdir(target, { mode: 0o700 });
    await mkdir(join(file.data, "updates"), { mode: 0o700 });
    await writeFile(join(target, `${HASH}.json`), "keep original\n", { mode: 0o600 });
    await symlink(target, join(file.data, "updates/candidates"));
    const result = await reconcileTransaction({
      channelRoot: file.channel,
      dataDirectory: file.data,
      running: running(file),
      inspectHelper: absentInspection,
    });
    expect(result.status).toBe("recovery-required");
    expect(await readLease(file.channel)).toEqual(journal);
    expect(await readdir(target)).toEqual([`${HASH}.json`]);
    expect(await readFile(join(target, `${HASH}.json`), "utf8")).toBe("keep original\n");
  } finally {
    await cleanup(file);
  }
});

async function exitedOwner(file: Fixture, mode: string): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, resolve("tests/fixtures/updater-journal-owner.ts"), file.root, mode],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    expect(await child.exited).toBe(0);
    expect(await errors).toBe("");
    await output;
    expect(child.pid).not.toBe(process.pid);
  } finally {
    clearTimeout(timeout);
  }
}

test("a different process retires its exited predecessor's exact success and failure", async () => {
  for (const mode of ["success", "failure"]) {
    const file = await fixture();
    try {
      await exitedOwner(file, mode);
      const result = await reconcileTransaction({
        channelRoot: file.channel,
        dataDirectory: file.data,
        running: { ...running(file), appBundlePath: join(file.root, "MCP Gateway.app") },
        inspectHelper: absentInspection,
      });
      expect(result.status).toBe(mode === "success" ? "confirmed" : "failed");
      expect(await readLease(file.channel)).toBeUndefined();
      const next = await TransactionLease.acquire({
        channelRoot: file.channel,
        dataDirectory: file.data,
        appBundlePath: file.app,
      });
      await next.releaseUncommitted();
    } finally {
      await cleanup(file);
    }
  }
});

test("recovers exited non-handoff owners before grant and after their writers are proven absent", async () => {
  for (const mode of ["operation", "prepared", "before-grant", "after-grant"]) {
    const file = await fixture();
    let pgid: number | undefined;
    try {
      await exitedOwner(file, mode);
      const journal = await readLease(file.channel);
      pgid = journal?.registered_group?.pgid;
      const options = { channelRoot: file.channel, dataDirectory: file.data };
      if (mode === "before-grant") {
        const { inspectRegisteredGroup } = await import("../../src/main/updater/registered-group");
        const group = journal?.registered_group;
        if (!group) throw new Error("Missing ungranted writer registration");
        for (let i = 0; i < 100 && (await inspectRegisteredGroup(group)).status !== "absent"; i++)
          await Bun.sleep(10);
        expect((await inspectRegisteredGroup(group)).status).toBe("absent");
        expect(await Bun.file(join(file.root, "group-ready")).exists()).toBe(false);
      }
      expect(
        (await reconcileTransaction({ ...options, inspectOwner: () => "unknown" })).status,
      ).toBe("recovery-required");
      if (mode === "after-grant") {
        expect((await reconcileTransaction(options)).status).toBe("recovery-required");
        const group = journal?.registered_group;
        if (!group || !pgid) throw new Error("Missing registered writer");
        process.kill(group.leader_pid, "SIGKILL");
        await Bun.sleep(30);
        expect((await reconcileTransaction(options)).status).toBe("recovery-required");
        process.kill(-pgid, "SIGKILL");
        const { inspectRegisteredGroup } = await import("../../src/main/updater/registered-group");
        for (let i = 0; i < 100 && (await inspectRegisteredGroup(group)).status !== "absent"; i++)
          await Bun.sleep(10);
      }
      expect(
        (
          await reconcileTransaction({
            ...options,
            ...(journal?.registered_group
              ? { inspectGroup: async () => ({ status: "unknown" as const, pids: [] }) }
              : {}),
          })
        ).status,
      ).toBe(journal?.registered_group ? "recovery-required" : "none");
      expect((await reconcileTransaction(options)).status).toBe("none");
      expect(await readLease(file.channel)).toBeUndefined();
    } finally {
      if (pgid) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {}
      }
      await cleanup(file);
    }
  }
});
