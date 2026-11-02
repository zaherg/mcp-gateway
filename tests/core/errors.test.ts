import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { failure, operational, visible } from "../../src/core/errors";

test("visible errors redact unexpected causes and preserve only explicit policy failures", async () => {
  for (const error of [new Error("SECRET upstream body"), { token: "SECRET" }, "SECRET", null]) {
    expect(visible(error)).toEqual({
      code: "BackendFailure",
      message: "The operation failed. Open Logs for details.",
      occurrenceId: expect.any(String),
    });
    const result = await Effect.runPromise(
      Effect.result(
        operational(
          async () => {
            throw error;
          },
          "ConfigIO",
          "Policy IO failure",
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(visible(result.failure)).toEqual({
        code: "ConfigIO",
        message: "Policy IO failure",
        occurrenceId: expect.any(String),
      });
  }
  const policy = failure("StaleRevision", "Reload before saving.");
  expect(visible(policy).occurrenceId).toBe(visible(policy).occurrenceId);
  expect(visible(failure("StaleRevision", "Reload before saving.")).occurrenceId).not.toBe(
    policy.occurrenceId,
  );
  const result = await Effect.runPromise(
    Effect.result(
      operational(
        async () => {
          throw policy;
        },
        "ConfigIO",
        "Must not replace policy",
      ),
    ),
  );
  if (!Result.isFailure(result)) throw new Error("Expected policy failure");
  expect(result.failure).toBe(policy);
  expect(visible(policy)).toEqual({
    code: "StaleRevision",
    message: "Reload before saving.",
    occurrenceId: expect.any(String),
  });
  expect(await Effect.runPromise(operational(async () => 42, "ConfigIO", "unused"))).toBe(42);
});
