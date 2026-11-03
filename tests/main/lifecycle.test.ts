import { expect, test } from "bun:test";
import { QuitCoordinator } from "../../src/main/lifecycle";
import type { HandoffSession } from "../../src/main/updater/handoff";
import { withQuitInvocation } from "../../src/main/updater/invocation";
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

function updateCandidate(
  version = "0.3.2",
): import("../../src/main/updater/candidate").FrozenCandidate {
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

function startUpdate(
  coordinator: QuitCoordinator,
  version = "0.3.2",
): ReturnType<typeof updateCandidate> {
  const candidate = updateCandidate(version);
  const attempt = coordinator.reserveUpdate(candidate);
  if (!attempt) throw new Error("reservation failed");
  if (!coordinator.acceptUpdateRestart(attempt)) throw new Error("restart refused");
  withQuitInvocation({ kind: "begin-update-shutdown", attemptId: attempt.id }, () => {
    coordinator.handle(() => {});
  });
  return candidate;
}

test("a normal quit clears an armed update and never installs on quit", async () => {
  let quits = 0;
  const dispatched: string[] = [];
  const coordinator = new QuitCoordinator(
    async () => {},
    () => {
      quits++;
    },
    () => {},
    async (attempt) => {
      dispatched.push(attempt.candidate.version);
      return { kind: "committed", binding: null, certainty: "uncertain", parentMayExit: true };
    },
  );
  expect(coordinator.reserveUpdate(updateCandidate())).toBeDefined();
  expect(coordinator.armQuit()).toBe(true);
  coordinator.handle(() => {});
  await eventually(() => quits === 1);
  expect(dispatched).toEqual([]);
});

test("restart-to-update dispatches the exact reserved attempt after successful cleanup", async () => {
  let quits = 0;
  const dispatched: string[] = [];
  const coordinator = new QuitCoordinator(
    async () => {},
    () => {
      quits++;
    },
    () => {},
    async (attempt) => {
      dispatched.push(`${attempt.candidate.version}:${attempt.candidate.hash}`);
      return { kind: "committed", binding: null, certainty: "uncertain", parentMayExit: true };
    },
  );
  startUpdate(coordinator);
  await eventually(() => dispatched.length === 1);
  expect(dispatched).toEqual(["0.3.2:next123456"]);
  expect(quits).toBe(0);
  expect(coordinator.status().phase).toBe("failed");
});

test("failed update handoff keeps a stopped app visible with a sanitized retryable failure", async () => {
  let quits = 0;
  const failures: Array<{ error: unknown; kind: string }> = [];
  const coordinator = new QuitCoordinator(
    async () => {},
    () => {
      quits++;
    },
    (error, kind) => failures.push({ error, kind }),
    async () => {
      throw new Error("private-handoff-detail");
    },
  );
  startUpdate(coordinator);
  await eventually(() => coordinator.status().phase === "failed");
  expect(quits).toBe(0);
  expect(coordinator.status().error).toBe(
    "Update handoff failed. The gateway is stopped. Retry Update or Quit.",
  );
  expect(JSON.stringify(coordinator.status())).not.toContain("private-handoff");
  expect(failures).toHaveLength(1);
  expect(failures[0]?.kind).toBe("update");
  coordinator.armQuit();
  coordinator.handle(() => {});
  await eventually(() => quits === 1);
});

test("failed cleanup does not dispatch an update and allows an explicit retry", async () => {
  let attempts = 0;
  let dispatched = 0;
  let failures = 0;
  const coordinator = new QuitCoordinator(
    async () => {
      if (++attempts === 1) throw new Error("private-cleanup-detail");
    },
    () => {},
    (_error, kind) => {
      if (kind === "update") failures++;
    },
    async () => {
      dispatched++;
      return { kind: "committed", binding: null, certainty: "uncertain", parentMayExit: true };
    },
  );
  startUpdate(coordinator);
  await eventually(() => coordinator.status().phase === "failed");
  expect(dispatched).toBe(0);
  expect(failures).toBe(1);
  expect(coordinator.status().error).toBe(
    "Update cleanup failed. The app has not exited. Retry Update or Quit.",
  );
  expect(JSON.stringify(coordinator.status())).not.toContain("private-cleanup");
  startUpdate(coordinator, "0.3.3");
  await eventually(() => dispatched === 1);
  expect(coordinator.status().phase).toBe("failed");
});

test("ordinary Quit can replace an update intent while delayed cleanup is pending", async () => {
  let finish: () => void = () => {};
  let started = false;
  let quits = 0;
  const dispatched: string[] = [];
  const coordinator = new QuitCoordinator(
    () =>
      new Promise<void>((resolve) => {
        started = true;
        finish = resolve;
      }),
    () => {
      quits++;
    },
    () => {},
    async (attempt) => {
      dispatched.push(attempt.candidate.version);
      return { kind: "committed", binding: null, certainty: "uncertain", parentMayExit: true };
    },
  );
  startUpdate(coordinator);
  await eventually(() => started);
  expect(coordinator.armQuit()).toBe(true);
  finish();
  await eventually(() => quits === 1);
  expect(dispatched).toEqual([]);
  expect(coordinator.status().phase).toBe("ready");
});

test("ordinary Quit during final revalidation aborts and waits for unarmed settlement", async () => {
  let release: () => void = () => {};
  let started = false;
  let quits = 0;
  let observedAbort = false;
  const coordinator = new QuitCoordinator(
    async () => {},
    () => {
      quits++;
    },
    () => {},
    async (attempt) => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      observedAbort = attempt.signal.aborted;
      return { kind: "unarmed", reason: "cancelled" };
    },
  );
  startUpdate(coordinator);
  await eventually(() => started);
  expect(coordinator.armQuit()).toBe(true);
  let vetoes = 0;
  coordinator.handle(() => {
    vetoes++;
  });
  coordinator.handle(() => {
    vetoes++;
  });
  expect(vetoes).toBe(2);
  release();
  await eventually(() => quits === 1);
  expect(observedAbort).toBe(true);
  expect(coordinator.status().phase).toBe("ready");
});

test("tagged SDK approval is offered once; stale tagged events are vetoed", async () => {
  let offer = 0;
  let vetoes = 0;
  let registered = false;
  let coordinator: QuitCoordinator;
  coordinator = new QuitCoordinator(
    async () => {},
    () => {},
    () => {},
    async (attempt) => {
      const session = {
        attemptId: attempt.id,
        callId: "call-1",
        offerApprovalSync: (): boolean => {
          offer++;
          return true;
        },
      } as unknown as HandoffSession;
      expect(coordinator.registerHandoff(session)).toBe(true);
      withQuitInvocation({ kind: "sdk-apply", attemptId: attempt.id, callId: "call-1" }, () =>
        coordinator.handle(() => {
          vetoes++;
        }),
      );
      registered = true;
      return { kind: "committed", binding: null, certainty: "uncertain", parentMayExit: true };
    },
  );
  startUpdate(coordinator);
  await eventually(() => registered);
  expect(offer).toBe(1);
  expect(vetoes).toBe(0);
  expect(coordinator.status().phase).toBe("failed");
});

test("ordinary Quit survives a rejected final revalidation/preparation", async () => {
  let release: () => void = () => {};
  let started = false;
  let quits = 0;
  const coordinator = new QuitCoordinator(
    async () => {},
    () => {
      quits++;
    },
    () => {},
    async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("handoff preparation failed after ordinary quit");
    },
  );
  startUpdate(coordinator);
  await eventually(() => started);
  expect(coordinator.armQuit()).toBe(true);
  coordinator.handle(() => {});
  release();
  await eventually(() => quits === 1);
  expect(coordinator.status().phase).toBe("ready");
});
