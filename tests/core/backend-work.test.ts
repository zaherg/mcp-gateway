import { expect, test } from "bun:test";
import {
  BACKEND_CAPACITY_ERROR,
  BackendCalls,
  MAX_BACKEND_CALLS,
  releaseAfterCleanup,
} from "../../src/core/backend-work";

test("backend calls are owned per request owner and exact request id", () => {
  const calls = new BackendCalls(3);
  const first = calls.owner();
  const second = calls.owner();
  expect(calls.admit(first, 0)).toBe(true);
  expect(calls.admit(first, "0")).toBe(true);
  expect(calls.holds(first, 0)).toBe(true);
  expect(calls.admit(first, 0)).toBe(false);
  expect(calls.holds(first, 0)).toBe(true);
  expect(calls.outstanding).toBe(2);
  expect(calls.admit(first, 2)).toBe(true);
  expect(calls.outstanding).toBe(3);
  expect(calls.admit(second, 0)).toBe(false);
  expect(calls.holds(second, 0)).toBe(false);
  expect(calls.settle(second, 0)).toBe(false);
  expect(calls.settle(first, "missing")).toBe(false);
  expect(calls.settle(first, 0)).toBe(true);
  expect(calls.outstanding).toBe(2);
  expect(calls.admit(second, 0)).toBe(true);
  expect(calls.settleOwner(first)).toBe(2);
  expect(calls.outstanding).toBe(1);
  expect(calls.settleOwner(first)).toBe(0);
  expect(calls.settleOwner(second)).toBe(1);
  expect(calls.outstanding).toBe(0);
});

test("backend work is released only after its owned cleanup fulfils", async () => {
  let released = 0;
  await expect(
    releaseAfterCleanup(Promise.resolve("done"), () => {
      released++;
    }),
  ).resolves.toBe("done");
  expect(released).toBe(1);
  await expect(
    releaseAfterCleanup(Promise.reject(new Error("unconfirmed cleanup")), () => {
      released++;
    }),
  ).rejects.toThrow("unconfirmed cleanup");
  expect(released).toBe(1);
});

test("the shared budget admits exactly its limit and refuses the next distinct call", () => {
  expect(MAX_BACKEND_CALLS).toBe(16);
  const calls = new BackendCalls();
  const owner = calls.owner();
  for (let id = 0; id < MAX_BACKEND_CALLS; id++) expect(calls.admit(owner, id)).toBe(true);
  expect(calls.admit(owner, MAX_BACKEND_CALLS)).toBe(false);
  expect(calls.outstanding).toBe(MAX_BACKEND_CALLS);
  expect(calls.settle(owner, 0)).toBe(true);
  expect(calls.admit(owner, MAX_BACKEND_CALLS)).toBe(true);
});

test("application errors use a fixed documented code outside the reserved range", () => {
  expect(BACKEND_CAPACITY_ERROR).toEqual({
    code: 1001,
    message: "Backend work capacity is exhausted. Retry when outstanding calls finish.",
  });
});
