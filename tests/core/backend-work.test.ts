import { expect, test } from "bun:test";
import {
  BACKEND_CAPACITY_ERROR,
  BACKEND_ID_EXHAUSTED_ERROR,
  BackendCalls,
  BackendWireIds,
  DUPLICATE_REQUEST_ERROR,
  MAX_BACKEND_CALLS,
  releaseAfterCleanup,
} from "../../src/core/backend-work";

test("backend calls are owned per session and exact request id", () => {
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
  expect(DUPLICATE_REQUEST_ERROR).toEqual({
    code: -32600,
    message: "Duplicate in-flight request id.",
  });
  expect(BACKEND_ID_EXHAUSTED_ERROR).toEqual({
    code: 1001,
    message: "Backend request id capacity is exhausted.",
  });
});

test("backend wire ids are monotonic, never reused, and translate only active mappings", () => {
  const ids = new BackendWireIds();
  const zero = ids.register(0);
  const stringZero = ids.register("0");
  expect(zero).toBe(1);
  expect(stringZero).toBe(2);
  expect(ids.holds(0)).toBe(true);
  expect(ids.holds("0")).toBe(true);
  expect(ids.holds("missing")).toBe(false);
  expect(ids.size).toBe(2);
  expect(ids.wireOf(0)).toBe(1);
  expect(ids.wireOf("0")).toBe(2);
  expect(ids.take(1)).toBe(0);
  expect(ids.take(1)).toBeUndefined();
  expect(ids.holds(0)).toBe(false);
  expect(ids.take(2)).toBe("0");
  const reused = ids.register(0);
  expect(reused).toBe(3);
  expect(ids.release(0)).toBe(3);
  expect(ids.release(0)).toBeUndefined();
  expect(ids.wireOf(0)).toBeUndefined();
  const late = ids.register(7);
  ids.clear();
  expect(ids.size).toBe(0);
  expect(ids.take(late as number)).toBeUndefined();
});

test("backend wire ids refuse exhaustion instead of wrapping", () => {
  const ids = new BackendWireIds(2);
  expect(ids.register(10)).toBe(1);
  expect(ids.register(11)).toBe(2);
  expect(ids.register(12)).toBeUndefined();
  expect(ids.size).toBe(2);
  expect(ids.release(10)).toBe(1);
  expect(ids.register(13)).toBeUndefined();
});
