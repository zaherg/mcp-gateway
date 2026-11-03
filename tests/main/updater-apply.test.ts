import { expect, test } from "bun:test";
import { type ApplySdk, applyVerifiedUpdate } from "../../src/main/updater/apply";
import type { ApplySettlement, HandoffSession } from "../../src/main/updater/handoff";
import { currentQuitInvocation } from "../../src/main/updater/invocation";
import type { UpdateAttempt } from "../../src/main/updater/transaction";

function attempt(id = 4, signal = new AbortController().signal): UpdateAttempt {
  return {
    id,
    signal,
    candidate: {
      schema_version: 1,
      identifier: "dev.srvr.mcpgateway",
      channel: "stable",
      version: "0.3.2",
      hash: "next123456",
      artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
      prepared_path: "/synthetic/prepared.json",
      prepared_sha256: "a".repeat(64),
      retained_tar_path: "/synthetic/target.tar",
      archive_sha256: "b".repeat(64),
      archive_bytes: 1,
      frozen_at: "2026-11-03T00:00:00.000Z",
    },
  };
}

function fakeSession(id: number, settlement: ApplySettlement) {
  const observations: string[] = [];
  const session = {
    attemptId: id,
    callId: "call-7",
    observeSdkStatusSync: (entry: { status: string }) => {
      observations.push(entry.status);
    },
    settleWithoutCall: () => settlement,
    settleReturnedCall: () => settlement,
    retainUnarmed: async () => {},
  };
  return {
    session: session as unknown as HandoffSession,
    observations: () => observations,
  };
}

test("invokes the pinned SDK inside the matching sdk-apply invocation and observes callbacks", async () => {
  const fake = fakeSession(4, {
    kind: "committed",
    binding: null,
    certainty: "uncertain",
    parentMayExit: true,
  });
  const seen: string[] = [];
  let registered: ((entry: { status: string }) => void) | null = null;
  const sdk: ApplySdk = {
    applyUpdate: async () => {
      const invocation = currentQuitInvocation();
      expect(invocation).toEqual({ kind: "sdk-apply", attemptId: 4, callId: "call-7" });
      registered?.({ status: "applying" });
      seen.push("apply");
    },
    onStatusChange: (callback) => {
      registered = callback;
    },
    getLocalInfo: async () => ({
      identifier: "dev.srvr.mcpgateway",
      channel: "stable",
      baseUrl: "https://github.com/zaherg/mcp-gateway/releases/latest/download",
      version: "0.3.1",
      hash: "current1234",
      name: "MCPGateway",
    }),
    appDataFolder: async () => "/synthetic/channel",
  };
  const outcome = await applyVerifiedUpdate(attempt(), fake.session, sdk);
  expect(outcome.settlement.kind).toBe("committed");
  expect(seen).toEqual(["apply"]);
  expect(fake.observations()).toEqual(["applying"]);
  expect(registered).toBeNull();
});

test("an aborted attempt settles unarmed without invoking SDK apply", async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = fakeSession(5, { kind: "unarmed", reason: "cancelled" });
  let applied = false;
  const sdk: ApplySdk = {
    applyUpdate: async () => {
      applied = true;
    },
    onStatusChange: () => {},
    getLocalInfo: async () => ({}) as never,
    appDataFolder: async () => "/synthetic/channel",
  };
  const outcome = await applyVerifiedUpdate(attempt(5, controller.signal), fake.session, sdk);
  expect(outcome.settlement).toEqual({ kind: "unarmed", reason: "cancelled" });
  expect(applied).toBe(false);
  expect(fake.observations()).toEqual([]);
});

for (const cancelled of [false, true]) {
  test(`failed preparation restoration requires recovery after ${cancelled ? "cancellation" : "SDK refusal"}`, async () => {
    const controller = new AbortController();
    if (cancelled) controller.abort();
    const reason = cancelled ? "cancelled" : "vetoed";
    const fake = fakeSession(4, { kind: "unarmed", reason });
    let restores = 0;
    let applies = 0;
    fake.session.retainUnarmed = async () => {
      restores++;
      throw new Error("Synthetic journal write refusal");
    };
    const sdk: ApplySdk = {
      applyUpdate: async () => {
        applies++;
      },
      onStatusChange: () => {},
      getLocalInfo: async () => {
        throw new Error("Unexpected metadata read");
      },
      appDataFolder: async () => {
        throw new Error("Unexpected path resolution");
      },
    };
    const outcome = await applyVerifiedUpdate(attempt(4, controller.signal), fake.session, sdk);
    expect(outcome.settlement).toEqual({ kind: "unarmed-recovery", reason });
    expect(restores).toBe(1);
    expect(applies).toBe(cancelled ? 0 : 1);
  });
}

test("refuses an attempt/session identity mismatch before the SDK call", async () => {
  const fake = fakeSession(9, { kind: "unarmed", reason: "vetoed" });
  let applied = false;
  const sdk: ApplySdk = {
    applyUpdate: async () => {
      applied = true;
    },
    onStatusChange: () => {},
    getLocalInfo: async () => ({}) as never,
    appDataFolder: async () => "/synthetic/channel",
  };
  await expect(applyVerifiedUpdate(attempt(8), fake.session, sdk)).rejects.toThrow(
    "update attempt/session mismatch",
  );
  expect(applied).toBe(false);
});
