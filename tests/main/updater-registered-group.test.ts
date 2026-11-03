import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  inspectRegisteredGroup,
  type RegisteredGroup,
  recoveryMayReleaseGroup,
} from "../../src/main/updater/registered-group";
import { eventually } from "../core/helpers";

const COORDINATOR = resolve("tests/fixtures/registered-group-coordinator.ts");
const _WORKER = resolve("tests/fixtures/registered-group-worker.ts");

async function runCoordinator(root: string, mode: "before" | "between" | "after") {
  const ready = join(root, "ready");
  const resultPath = join(root, "coordinator-result.json");
  const child = Bun.spawn([process.execPath, COORDINATOR, root, mode, ready], {
    cwd: resolve("."),
    env: { PATH: "/usr/bin:/bin", HOME: root },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  const result = JSON.parse(await readFile(resultPath, "utf8")) as {
    leaderPid: number;
    pgid: number;
    registrationPath: string | null;
  };
  return { ...result, ready, stderr: await stderr };
}

async function cleanupGroup(pgid: number): Promise<void> {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    try {
      process.kill(pgid, "SIGKILL");
    } catch {}
  }
}

test("persists registration after parent exit but before grant, then releases only when absent", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-registered-"));
  try {
    const between = await runCoordinator(root, "between");
    if (!between.registrationPath) throw new Error("registration was not persisted");
    const record = JSON.parse(await readFile(between.registrationPath, "utf8")) as RegisteredGroup;
    expect(record.leader_pid).toBe(between.leaderPid);
    const state = await inspectRegisteredGroup(record);
    expect(state.status).toBe("absent");
    expect(recoveryMayReleaseGroup(state)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a descendant surviving its worker leader keeps recovery blocked", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-registered-live-"));
  try {
    const after = await runCoordinator(root, "after");
    if (!after.registrationPath) throw new Error("registration was not persisted");
    const record = JSON.parse(await readFile(after.registrationPath, "utf8")) as RegisteredGroup;
    expect(record.leader_pid).toBe(after.leaderPid);
    const before = await inspectRegisteredGroup(record);
    expect(before.status).toBe("alive");
    const mutated = { ...record, leader_start: "not-the-start-time" };
    const mutatedState = await inspectRegisteredGroup(mutated);
    expect(mutatedState.status).toBe("unknown");
    expect(recoveryMayReleaseGroup(mutatedState)).toBe(false);
    process.kill(after.leaderPid, "SIGKILL");
    await eventually(async () => (await inspectRegisteredGroup(record)).status === "unknown");
    const state = await inspectRegisteredGroup(record);
    expect(state.status).toBe("unknown");
    expect(state.pids).not.toContain(after.leaderPid);
    expect(recoveryMayReleaseGroup(state)).toBe(false);
    await cleanupGroup(after.pgid);
    await eventually(async () => (await inspectRegisteredGroup(record)).status === "absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent exit before registration leaves no registration or running worker", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-registered-before-"));
  try {
    const before = await runCoordinator(root, "before");
    expect(before.registrationPath).toBeNull();
    expect(await readFile(join(root, "registered-group.json")).catch(() => null)).toBeNull();
    expect(await readFile(before.ready).catch(() => null)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
