import { expect, test } from "bun:test";
import { QuitCoordinator } from "../../src/main/lifecycle";
import { eventually } from "../core/helpers";

test("QuitCoordinator retries failed cleanup, coalesces repeated quit, and permits exit only after success", async () => {
  let attempts = 0;
  let failed = 0;
  let quits = 0;
  let vetoes = 0;
  const coordinator = new QuitCoordinator(
    async () => {
      if (++attempts === 1) throw new Error("synthetic failure");
    },
    () => {
      quits++;
    },
    () => {
      failed++;
    },
  );
  coordinator.handle(() => {
    vetoes++;
  });
  await eventually(() => failed === 1);
  coordinator.handle(() => {
    vetoes++;
  });
  coordinator.handle(() => {
    vetoes++;
  });
  await eventually(() => quits === 1);
  coordinator.handle(() => {
    vetoes++;
  });
  expect({ attempts, failed, quits, vetoes }).toEqual({
    attempts: 2,
    failed: 1,
    quits: 1,
    vetoes: 3,
  });
});

test("QuitCoordinator exposes sanitized attempt-scoped delayed failures and preserves veto during retry", async () => {
  let rejectCleanup = (_error: Error) => {};
  let finishCleanup = () => {};
  let calls = 0;
  let quits = 0;
  let vetoes = 0;
  const failures: unknown[] = [];
  const coordinator = new QuitCoordinator(
    () =>
      new Promise<void>((resolve, reject) => {
        calls++;
        rejectCleanup = reject;
        finishCleanup = resolve;
      }),
    () => {
      quits++;
    },
    (error) => {
      failures.push(error);
    },
  );
  expect(coordinator.status()).toEqual({ attempt: 0, phase: "idle", error: null });
  const veto = () => {
    vetoes++;
  };
  coordinator.handle(veto);
  coordinator.handle(veto);
  expect(coordinator.status()).toEqual({ attempt: 1, phase: "pending", error: null });
  await eventually(() => calls === 1);
  rejectCleanup(new Error("synthetic-private-cleanup"));
  await eventually(() => coordinator.status().phase === "failed");
  const failed = coordinator.status();
  expect(failed).toEqual({
    attempt: 1,
    phase: "failed",
    error: "Quit cleanup failed. The app has not exited. Retry Quit.",
  });
  expect(JSON.stringify(failed)).not.toContain("synthetic-private");
  expect(failures).toHaveLength(1);
  expect(quits).toBe(0);
  coordinator.handle(veto);
  coordinator.handle(veto);
  expect(coordinator.status()).toEqual({ attempt: 2, phase: "pending", error: null });
  expect(failed.phase).toBe("failed");
  await eventually(() => calls === 2);
  expect(quits).toBe(0);
  finishCleanup();
  await eventually(() => quits === 1);
  expect(coordinator.status()).toEqual({ attempt: 2, phase: "ready", error: null });
  coordinator.handle(veto);
  expect(vetoes).toBe(4);
});

test("QuitCoordinator retains failure feedback when native exit throws after cleanup completed", async () => {
  let cleaned = 0;
  let exits = 0;
  const coordinator = new QuitCoordinator(
    async () => {
      cleaned++;
    },
    () => {
      if (++exits === 1) throw new Error("synthetic-private-exit");
    },
    () => {},
  );
  coordinator.handle(() => {});
  await eventually(() => coordinator.status().phase === "failed");
  expect(cleaned).toBe(1);
  expect(JSON.stringify(coordinator.status())).not.toContain("synthetic-private");
  let vetoed = false;
  coordinator.handle(() => {
    vetoed = true;
  });
  expect(vetoed).toBe(true);
  expect(coordinator.status()).toMatchObject({ attempt: 2, phase: "pending" });
  await eventually(() => coordinator.status().phase === "ready");
  expect(exits).toBe(2);
});
