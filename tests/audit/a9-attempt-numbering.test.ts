import { expect, test } from "bun:test";
import { QuitCoordinator } from "../../src/main/lifecycle";
import type { FrozenCandidate } from "../../src/main/updater/candidate";
import { eventually } from "../core/helpers";

function candidate(version = "0.3.2"): FrozenCandidate {
  return {
    schema_version: 1,
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    version,
    hash: "next123456",
    artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
    prepared_path: "/synthetic/prepared.json",
    prepared_sha256: "a".repeat(64),
    retained_tar_path: "/synthetic/target.tar",
    archive_sha256: "b".repeat(64),
    archive_bytes: 1,
    frozen_at: "2026-11-03T00:00:00.000Z",
  };
}

function failingQuit() {
  let calls = 0;
  const quit = new QuitCoordinator(
    async () => {
      calls++;
      throw new Error("synthetic cleanup refusal");
    },
    () => {},
    () => {},
  );
  return { quit, calls: () => calls };
}

async function failQuit(quit: QuitCoordinator, expectedAttempt: number): Promise<void> {
  quit.handle(() => {});
  await eventually(() => quit.status().phase === "failed");
  expect(quit.status().attempt).toBe(expectedAttempt);
}

test("A9: two failed Quits followed by update allocate exactly 1, 2, 3", async () => {
  const { quit, calls } = failingQuit();
  await failQuit(quit, 1);
  await failQuit(quit, 2);
  expect(calls()).toBe(2);
  const attempt = quit.reserveUpdate(candidate());
  expect(attempt?.id).toBe(3);
  expect(quit.status()).toEqual({
    attempt: 3,
    phase: "failed",
    error: "Quit cleanup failed. The app has not exited. Retry Quit.",
  });
});

test("A9: update, failed ordinary Quit, and another update stay monotonic", async () => {
  const { quit } = failingQuit();
  const first = quit.reserveUpdate(candidate());
  if (!first) throw new Error("Expected first update reservation");
  expect(first.id).toBe(1);
  expect(quit.armQuit()).toBe(true);
  await failQuit(quit, 2);
  expect(first.signal.aborted).toBe(true);
  expect(quit.reserveUpdate(candidate("0.3.3"))?.id).toBe(3);
});

test("A9 control: duplicate in-flight Quit requests coalesce; settled failure retries", async () => {
  const { quit, calls } = failingQuit();
  quit.handle(() => {});
  quit.handle(() => {});
  quit.handle(() => {});
  await eventually(() => quit.status().phase === "failed");
  expect(quit.status().attempt).toBe(1);
  expect(calls()).toBe(1);
  await failQuit(quit, 2);
  expect(calls()).toBe(2);
});

test("A9 control: a successful ordinary Quit cannot reserve a later update", async () => {
  const quit = new QuitCoordinator(
    async () => {},
    () => {},
    () => {},
  );
  quit.handle(() => {});
  await eventually(() => quit.status().phase === "ready");
  expect(quit.reserveUpdate(candidate())).toBeUndefined();
});
