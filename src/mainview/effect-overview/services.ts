import { UiSchema } from '@effect/ui';
import { Context, Effect, Layer, Schema } from 'effect';

export const TestServerOutcome = UiSchema.TaggedEnum({
  Passed: { protocolVersion: Schema.String },
  Failed: { message: Schema.String },
  Cancelled: { message: Schema.String },
  Unavailable: {},
});

export type TestServerOutcomeValue = typeof TestServerOutcome.Type;

export interface OverviewActionsService {
  readonly clearError: () => Effect.Effect<void>;
  readonly dismissOperationalError: () => Effect.Effect<void>;
  readonly dismissKeyReminder: () => Effect.Effect<void>;
  readonly openKeyMigration: () => Effect.Effect<void>;
  readonly openServerEditor: (name: string | null) => Effect.Effect<void>;
  readonly openBearPreset: () => Effect.Effect<void>;
  readonly toggleServer: (name: string, disabled: boolean) => Effect.Effect<void>;
  readonly deleteServer: (name: string) => Effect.Effect<void>;
  readonly copyClientConfig: (name: string) => Effect.Effect<boolean>;
  readonly testServer: (
    name: string,
    expectedRevision: string,
  ) => Effect.Effect<TestServerOutcomeValue>;
}

export interface OverviewCallbacks {
  readonly clearError: () => void;
  readonly dismissOperationalError: () => void;
  readonly dismissKeyReminder: () => void;
  readonly openKeyMigration: () => void;
  readonly openServerEditor: (name?: string) => void;
  readonly openBearPreset: () => void;
  readonly toggleServer: (name: string, disabled: boolean) => Promise<void>;
  readonly deleteServer: (name: string) => Promise<void>;
  readonly copyClientConfig: (name: string) => Promise<boolean>;
  readonly testServer: (name: string, expectedRevision: string) => Promise<TestServerOutcomeValue>;
}

export class OverviewActions extends Context.Service<OverviewActions, OverviewActionsService>()(
  'mcp-gateway/overview/OverviewActions',
) {
  static readonly fromRef = (ref: { readonly current: OverviewCallbacks }) =>
    Layer.succeed(OverviewActions, {
      clearError: () =>
        Effect.sync(() => {
          ref.current.clearError();
        }),
      dismissOperationalError: () =>
        Effect.sync(() => {
          ref.current.dismissOperationalError();
        }),
      dismissKeyReminder: () =>
        Effect.sync(() => {
          ref.current.dismissKeyReminder();
        }),
      openKeyMigration: () =>
        Effect.sync(() => {
          ref.current.openKeyMigration();
        }),
      openServerEditor: (name) =>
        Effect.sync(() => {
          ref.current.openServerEditor(name ?? undefined);
        }),
      openBearPreset: () =>
        Effect.sync(() => {
          ref.current.openBearPreset();
        }),
      toggleServer: (name, disabled) =>
        Effect.promise(() => ref.current.toggleServer(name, disabled)),
      deleteServer: (name) => Effect.promise(() => ref.current.deleteServer(name)),
      copyClientConfig: (name) => Effect.promise(() => ref.current.copyClientConfig(name)),
      testServer: (name, expectedRevision) =>
        Effect.promise(() => ref.current.testServer(name, expectedRevision)),
    });

  static readonly noop = Layer.succeed(OverviewActions, {
    clearError: () => Effect.void,
    dismissOperationalError: () => Effect.void,
    dismissKeyReminder: () => Effect.void,
    openKeyMigration: () => Effect.void,
    openServerEditor: () => Effect.void,
    openBearPreset: () => Effect.void,
    toggleServer: () => Effect.void,
    deleteServer: () => Effect.void,
    copyClientConfig: () => Effect.succeed(true),
    testServer: () => Effect.succeed(TestServerOutcome.Passed({ protocolVersion: '2025-11-25' })),
  });
}
