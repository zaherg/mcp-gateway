import { Data, Effect } from "effect";
import type { GatewayErrorCode, VisibleError } from "../shared/types";

// Only policy text or allowlisted structured summaries belong here, never raw diagnostics.
export class GatewayError extends Data.TaggedError("GatewayError")<VisibleError> {}

export function failure(code: GatewayErrorCode, message: string): GatewayError {
  return new GatewayError({ code, message, occurrenceId: `issue-${++issueSequence}` });
}

let issueSequence = 0;
export function visible(error: unknown): VisibleError {
  return error instanceof GatewayError
    ? { code: error.code, message: error.message, occurrenceId: error.occurrenceId }
    : {
        code: "BackendFailure",
        message: "The operation failed. Open Logs for details.",
        occurrenceId: `issue-${++issueSequence}`,
      };
}

export function operational<A>(
  run: () => Promise<A>,
  code: GatewayErrorCode,
  message: string,
): Effect.Effect<A, GatewayError> {
  return Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof GatewayError ? error : failure(code, message)),
  });
}
