import { test as bunTest, expect } from "bun:test";

// Transaction integration acquires the macOS kernel guard; policy tests remain portable.
const test = bunTest.skipIf(process.platform !== "darwin");

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FrozenCandidate } from "../../src/main/updater/candidate";
import {
  type HandoffAuthority,
  HandoffSessionImplementation,
} from "../../src/main/updater/handoff";
import { withQuitInvocation } from "../../src/main/updater/invocation";
import {
  type ExpectedNativePlan,
  nativePlanPath,
  nativeResultPath,
  readLease,
  TransactionLease,
  type UpdateAttempt,
} from "../../src/main/updater/transaction";

const HASH = "target123456";
const VERSION = "0.3.1";
const ID = "0123456789abcdef0123456789abcdef";

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

type Fixture = {
  root: string;
  channel: string;
  data: string;
  app: string;
  temporary: string;
  lease: TransactionLease;
  attempt: UpdateAttempt;
  expected: ExpectedNativePlan;
  callId: string;
  authority: HandoffAuthority;
  session: HandoffSessionImplementation;
};

async function fixture(): Promise<Fixture> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-session-"));
  const home = join(root, "home");
  const channel = join(home, "Library/Application Support/dev.srvr.mcpgateway/stable");
  const data = join(root, "data");
  const app = join(home, "Applications/MCP Gateway.app");
  const temporary = join(root, "tmp");
  await mkdir(channel, { recursive: true, mode: 0o700 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  await mkdir(join(app, "Contents/Resources"), { recursive: true });
  const lease = await TransactionLease.acquire({
    channelRoot: channel,
    dataDirectory: data,
    appBundlePath: app,
  });
  await lease.markPrepared(candidate(), "/synthetic/previous.app");
  const attempt: UpdateAttempt = {
    id: 11,
    candidate: candidate(),
    signal: new AbortController().signal,
  };
  const expected: ExpectedNativePlan = {
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    platform: "macos",
    arch: "arm64",
    version: VERSION,
    hash: HASH,
    channelRoot: channel,
    appBundlePath: app,
    retainedTarPath: candidate().retained_tar_path,
    parentPid: 4242,
    physicalTemporaryDirectory: temporary,
  };
  await lease.prepareHandoff(attempt, expected, []);
  const callId = "call-1";
  const authority: HandoffAuthority = {
    isCurrentUpdate: (attemptId) => attemptId === attempt.id,
    isCleanupComplete: (attemptId) => attemptId === attempt.id,
    attemptSignal: (attemptId) => (attemptId === attempt.id ? attempt.signal : undefined),
  };
  const session = new HandoffSessionImplementation(lease, attempt, expected, callId, authority);
  return {
    root,
    channel,
    data,
    app,
    temporary,
    lease,
    attempt,
    expected,
    callId,
    authority,
    session,
  };
}

function planDocument(file: Fixture): Record<string, unknown> {
  return {
    schema_version: 1,
    transaction_id: ID,
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    platform: "macos",
    arch: "arm64",
    version: VERSION,
    hash: HASH,
    channel_root: file.channel,
    app_bundle_path: file.app,
    retained_tar_path: candidate().retained_tar_path,
    parent_pid: file.expected.parentPid,
    result_path: nativeResultPath(file.channel, ID),
  };
}

function withApply<T>(file: Fixture, work: () => T): T {
  return withQuitInvocation(
    { kind: "sdk-apply", attemptId: file.attempt.id, callId: file.callId },
    work,
  );
}

test("arms synchronously only inside the matching tagged SDK invocation", async () => {
  const file = await fixture();
  try {
    expect(file.session.offerApprovalSync()).toBe(false);
    const armed = withApply(file, () => file.session.offerApprovalSync());
    expect(armed).toBe(true);
    expect((await readLease(file.channel))?.phase).toBe("arming");
    expect(withApply(file, () => file.session.offerApprovalSync())).toBe(false);
    file.session.releaseGuard();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("persists the exact observed plan before the SDK callback returns", async () => {
  const file = await fixture();
  try {
    withApply(file, () => expect(file.session.offerApprovalSync()).toBe(true));
    await writeFile(nativePlanPath(file.channel, ID), JSON.stringify(planDocument(file)), {
      mode: 0o600,
    });
    withApply(file, () => {
      file.session.observeSdkStatusSync({ status: "applying" });
      file.session.observeSdkStatusSync({ status: "launching-new-version" });
    });
    const journal = await readLease(file.channel);
    expect(journal).toMatchObject({
      phase: "handed-off",
      binding: { evidence: "observed-plan", transactionId: ID },
    });
    expect(file.session.settleReturnedCall()).toMatchObject({
      kind: "committed",
      certainty: "bound",
      parentMayExit: true,
    });
    file.session.releaseGuard();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("binds a unique early failure result as limited evidence", async () => {
  const file = await fixture();
  try {
    withApply(file, () => expect(file.session.offerApprovalSync()).toBe(true));
    await writeFile(
      nativeResultPath(file.channel, ID),
      JSON.stringify({
        schema_version: 1,
        transaction_id: ID,
        success: false,
        phase: "validating",
        message: "validation failed",
        identifier: "dev.srvr.mcpgateway",
        channel: "stable",
        version: VERSION,
        hash: HASH,
      }),
      { mode: 0o644 },
    );
    withApply(file, () => file.session.observeSdkStatusSync({ status: "launching-new-version" }));
    expect((await readLease(file.channel))?.binding).toMatchObject({
      evidence: "early-terminal-result",
      transactionId: ID,
    });
    expect(file.session.settleReturnedCall()).toMatchObject({
      kind: "committed",
      certainty: "bound",
    });
    file.session.releaseGuard();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("keeps arming durable and reports uncertainty when the SDK returns an error after approval", async () => {
  const file = await fixture();
  try {
    withApply(file, () => expect(file.session.offerApprovalSync()).toBe(true));
    withApply(file, () => file.session.observeSdkStatusSync({ status: "applying" }));
    const settlement = file.session.settleReturnedCall(new Error("private SDK detail"));
    expect(settlement).toMatchObject({
      kind: "committed",
      binding: null,
      certainty: "uncertain",
    });
    expect((await readLease(file.channel))?.phase).toBe("arming");
    await expect(file.session.retireUnarmed()).rejects.toThrow();
    expect(JSON.stringify(settlement)).not.toContain("private SDK detail");
    file.session.releaseGuard();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("settles a pre-approval veto as unarmed and retires only that journal", async () => {
  const file = await fixture();
  try {
    const settlement = withApply(file, () => {
      file.session.observeSdkStatusSync({ status: "idle" });
      return file.session.settleReturnedCall();
    });
    expect(settlement).toEqual({ kind: "unarmed", reason: "vetoed" });
    await file.session.retireUnarmed();
    expect(await readLease(file.channel)).toBeUndefined();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("an offered approval followed by the tagged idle veto settles unarmed", async () => {
  const file = await fixture();
  try {
    withApply(file, () => expect(file.session.offerApprovalSync()).toBe(true));
    const settlement = withApply(file, () => {
      file.session.observeSdkStatusSync({ status: "idle" });
      return file.session.settleReturnedCall();
    });
    expect(settlement).toEqual({ kind: "unarmed", reason: "vetoed" });
    await file.session.retireUnarmed();
    expect(await readLease(file.channel)).toBeUndefined();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("a binding persistence failure keeps arming and reports uncertainty without throwing", async () => {
  const file = await fixture();
  try {
    withApply(file, () => expect(file.session.offerApprovalSync()).toBe(true));
    await writeFile(nativePlanPath(file.channel, ID), JSON.stringify(planDocument(file)), {
      mode: 0o600,
    });
    const leaseDirectory = join(file.channel, ".mcp-gateway-update-transaction");
    await chmod(leaseDirectory, 0o500);
    try {
      withApply(file, () => {
        expect(() =>
          file.session.observeSdkStatusSync({ status: "launching-new-version" }),
        ).not.toThrow();
      });
    } finally {
      await chmod(leaseDirectory, 0o700);
    }
    expect(file.session.settleReturnedCall()).toMatchObject({
      kind: "committed",
      binding: null,
      certainty: "uncertain",
    });
    expect((await readLease(file.channel))?.phase).toBe("arming");
    file.session.releaseGuard();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("a pre-approval SDK error settles unarmed and permits retirement", async () => {
  const file = await fixture();
  try {
    const settlement = withApply(file, () => {
      file.session.observeSdkStatusSync({ status: "error" });
      return file.session.settleReturnedCall();
    });
    expect(settlement).toEqual({ kind: "unarmed", reason: "preapproval-error" });
    await file.session.retireUnarmed();
    expect(await readLease(file.channel)).toBeUndefined();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});
