import { UiSchema } from '@effect/ui';
import { Schema } from 'effect';

export const TestServerOutcome = UiSchema.TaggedEnum({
  Passed: { protocolVersion: Schema.String },
  Failed: { message: Schema.String },
  Cancelled: { message: Schema.String },
  Unavailable: {},
});

export type TestServerOutcomeValue = typeof TestServerOutcome.Type;
