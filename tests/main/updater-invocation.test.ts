import { expect, test } from "bun:test";
import {
  asOrdinaryQuit,
  currentQuitInvocation,
  withQuitInvocation,
} from "../../src/main/updater/invocation";

test("invocation context is scoped, immutable, and resets after async work", async () => {
  await withQuitInvocation({ kind: "sdk-apply", attemptId: 7, callId: "call-1" }, async () => {
    expect(currentQuitInvocation()).toEqual({ kind: "sdk-apply", attemptId: 7, callId: "call-1" });
    await Bun.sleep(0);
    expect(currentQuitInvocation()).toEqual({ kind: "sdk-apply", attemptId: 7, callId: "call-1" });
    await asOrdinaryQuit(async () => {
      expect(currentQuitInvocation()).toEqual({ kind: "ordinary" });
      await Bun.sleep(0);
    });
    expect(currentQuitInvocation()).toEqual({ kind: "sdk-apply", attemptId: 7, callId: "call-1" });
  });
  expect(currentQuitInvocation()).toBeUndefined();
});
