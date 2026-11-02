import { expect, test } from "bun:test";
import { MacLoginManager } from "../../src/main/login";

for (const [code, enabled, supported, error] of [
  [-1, false, false, "signed release"],
  [0, false, true, null],
  [1, true, true, null],
  [2, false, true, "Approve"],
  [3, false, true, "could not locate"],
] as const) {
  test(`MacLoginManager exposes actual native status ${code} without assuming desired state`, () => {
    const status = new MacLoginManager({
      status: () => code,
      set: () => {
        throw new Error("Must not register on read");
      },
    }).status();
    expect(status.enabled).toBe(enabled);
    expect(status.supported).toBe(supported);
    if (error) expect(status.error).toContain(error);
    else expect(status.error).toBeNull();
  });
}

test("MacLoginManager clears the pending warning when native approval completes without another mutation", () => {
  let status = 0;
  let result = 1;
  let calls = 0;
  const manager = new MacLoginManager({
    status: () => status,
    set: () => {
      calls++;
      return result;
    },
  });
  expect(manager.setEnabled(true).error).toContain("refused");
  result = 0;
  status = 2;
  const pending = manager.setEnabled(true);
  expect(pending.enabled).toBe(false);
  expect(pending.error).toContain("does not yet match");
  status = 1;
  expect(manager.status()).toEqual({ enabled: true, supported: true, error: null });
  expect(calls).toBe(2);
});

test("refused unregister remains unresolved while pending and clears only when unregistered", () => {
  let nativeStatus = 2;
  let calls = 0;
  const manager = new MacLoginManager({
    status: () => nativeStatus,
    set: () => {
      calls++;
      return 1;
    },
  });
  const refused = manager.setEnabled(false);
  expect(refused.enabled).toBe(false);
  expect(refused.supported).toBe(true);
  expect(refused.error).toContain("refused");
  expect(manager.status()).toEqual(refused);
  expect(calls).toBe(1);
  nativeStatus = 3;
  expect(manager.status()).toEqual(refused);
  nativeStatus = 0;
  expect(manager.status()).toEqual({ enabled: false, supported: true, error: null });
  nativeStatus = 2;
  const again = manager.setEnabled(false);
  expect(again.error).toBe(refused.error);
  expect(again.occurrenceId).not.toBe(refused.occurrenceId);
  expect(manager.status()).toEqual(again);
  expect(calls).toBe(2);
});
