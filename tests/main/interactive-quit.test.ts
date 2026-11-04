import { expect, test } from "bun:test";
import { InteractiveQuitGate } from "../../src/main/interactive-quit";
import { QuitCoordinator } from "../../src/main/lifecycle";
import { asOrdinaryQuit, withQuitInvocation } from "../../src/main/updater/invocation";
import { eventually } from "../core/helpers";

function fixture(
  request: () => Promise<boolean> | undefined,
  failCleanup = false,
  signalRequested = () => false,
) {
  let cleaned = 0;
  let exits = 0;
  let vetoes = 0;
  let failures = 0;
  const errors: unknown[] = [];
  const lifecycle = new QuitCoordinator(
    async () => {
      cleaned++;
      if (failCleanup && cleaned === 1) throw new Error("synthetic cleanup refusal");
    },
    () => {
      exits++;
    },
    () => {
      failures++;
    },
  );
  const native = () =>
    gate.handle(() => {
      vetoes++;
    });
  const gate = new InteractiveQuitGate(
    lifecycle,
    request,
    native,
    (error) => errors.push(error),
    signalRequested,
  );
  const approved = () =>
    asOrdinaryQuit(() => {
      lifecycle.armQuit();
      native();
    });
  return {
    lifecycle,
    native,
    approved,
    errors,
    state: () => ({ cleaned, exits, vetoes, failures }),
  };
}

test("native quit vetoes synchronously, coalesces delivery, and never treats acknowledgement as consent", async () => {
  let calls = 0;
  let acknowledge!: (value: boolean) => void;
  const f = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      acknowledge = resolve;
    });
  });
  f.native();
  f.native();
  f.native();
  expect(f.state()).toEqual({ cleaned: 0, exits: 0, vetoes: 3, failures: 0 });
  await eventually(() => calls === 1);
  expect(f.lifecycle.status()).toEqual({ attempt: 0, phase: "idle", error: null });
  acknowledge(true);
  await Bun.sleep(0);
  expect(f.state().cleaned).toBe(0);
  // The renderer can cancel the prompt and resume editing without a lifecycle mutation.
  expect(f.lifecycle.status().phase).toBe("idle");
  f.approved();
  f.approved();
  await eventually(() => f.state().exits === 1);
  expect(f.state().cleaned).toBe(1);
  expect(f.lifecycle.status().attempt).toBe(1);
});

for (const mode of ["refused", "lost", "delayed"] as const) {
  test(`native ${mode} acknowledgement cannot start cleanup or consume draft authority`, async () => {
    let settle!: (value: boolean) => void;
    const f = fixture(() =>
      mode === "refused"
        ? Promise.resolve(false)
        : mode === "lost"
          ? Promise.reject(new Error("synthetic timeout"))
          : new Promise((resolve) => {
              settle = resolve;
            }),
    );
    f.native();
    await Bun.sleep(0);
    if (mode === "delayed") {
      f.native();
      expect(f.errors).toHaveLength(0);
      expect(f.state().cleaned).toBe(0);
      settle(true);
      await Bun.sleep(0);
    } else expect(f.errors).toHaveLength(1);
    expect(f.lifecycle.status().phase).toBe("idle");
    expect(f.state().cleaned).toBe(0);
    expect(f.state().exits).toBe(0);
  });
}

test("a confirmed failure retries without another renderer decision and uses a higher attempt", async () => {
  let requests = 0;
  const f = fixture(() => {
    requests++;
    return Promise.resolve(true);
  }, true);
  f.native();
  await eventually(() => requests === 1);
  f.approved();
  await eventually(() => f.state().failures === 1);
  f.native();
  await eventually(() => f.state().exits === 1);
  expect(requests).toBe(1);
  expect(f.state().cleaned).toBe(2);
  expect(f.lifecycle.status().attempt).toBe(2);
});

test("windowless background Quit needs no fabricated renderer and signal Quit ignores a hung renderer", async () => {
  const background = fixture(() => undefined);
  background.native();
  await eventually(() => background.state().exits === 1);
  expect(background.state().cleaned).toBe(1);
  const visible = fixture(() => new Promise(() => {}));
  visible.native();
  await Bun.sleep(0);
  visible.approved();
  await eventually(() => visible.state().exits === 1);
  expect(visible.state().cleaned).toBe(1);
  expect(visible.errors).toEqual([]);
});

test("native signal intent bypasses an unanswered interactive request and survives cleanup retry", async () => {
  let signalled = false;
  let requests = 0;
  const f = fixture(
    () => {
      requests++;
      return new Promise(() => {});
    },
    true,
    () => signalled,
  );
  f.native();
  await eventually(() => requests === 1);
  signalled = true;
  f.native();
  await eventually(() => f.state().failures === 1);
  f.native();
  await eventually(() => f.state().exits === 1);
  expect(requests).toBe(1);
  expect(f.state().cleaned).toBe(2);
});

test("tagged stale SDK approval is vetoed by lifecycle without entering draft confirmation", async () => {
  let requests = 0;
  const f = fixture(() => {
    requests++;
    return Promise.resolve(true);
  });
  withQuitInvocation({ kind: "sdk-apply", attemptId: 10, callId: "not-current" }, f.native);
  withQuitInvocation({ kind: "begin-update-shutdown", attemptId: 10 }, f.native);
  await Bun.sleep(0);
  expect(requests).toBe(0);
  expect(f.state()).toEqual({ cleaned: 0, exits: 0, vetoes: 2, failures: 0 });
});
