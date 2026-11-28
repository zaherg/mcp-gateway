import { UiSchema } from '@effect/ui';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';

import type { ConfigFile } from '@mcp-gateway/shared/types';

export const GatewayMutation = UiSchema.TaggedEnum({
  SetLaunchAtLogin: { value: Schema.Boolean },
  SetAutoStart: { value: Schema.Boolean },
  SetKeepAwake: { value: Schema.Boolean },
  SetHost: { host: Schema.String },
  SetPort: { port: Schema.Number },
  SetAllowedPeers: { allowedPeers: Schema.NullOr(Schema.Array(Schema.String)) },
  SetToken: { token: Schema.Redacted(Schema.String) },
  ReplaceTokenWithLiteral: { token: Schema.Redacted(Schema.String) },
});

export type GatewayMutationValue = typeof GatewayMutation.Type;

export const applyGatewayMutation = (
  gateway: ConfigFile['gateway'],
  mutation: GatewayMutationValue,
): ConfigFile['gateway'] => {
  switch (mutation._tag) {
    case 'SetLaunchAtLogin':
      return { ...gateway, launchAtLogin: mutation.value };
    case 'SetAutoStart':
      return { ...gateway, autoStart: mutation.value };
    case 'SetKeepAwake':
      return { ...gateway, keepAwake: mutation.value || undefined };
    case 'SetHost':
      return { ...gateway, host: mutation.host };
    case 'SetPort':
      return { ...gateway, port: mutation.port };
    case 'SetAllowedPeers':
      return {
        ...gateway,
        allowedPeers: mutation.allowedPeers === null ? undefined : [...mutation.allowedPeers],
      };
    case 'SetToken':
      return { ...gateway, token: Redacted.value(mutation.token) };
    case 'ReplaceTokenWithLiteral':
      return { ...gateway, token: Redacted.value(mutation.token), tokenRef: undefined };
  }
};

export interface SettingsActionsService {
  readonly commitGatewayMutation: (mutation: GatewayMutationValue) => Effect.Effect<void>;
  readonly clearError: () => Effect.Effect<void>;
  readonly dismissOperationalError: () => Effect.Effect<void>;
  readonly setShowToken: (show: boolean) => Effect.Effect<void>;
  readonly openKeyMigration: () => Effect.Effect<void>;
  readonly changeLanguage: (preference: string) => Effect.Effect<void>;
  readonly changeAppearance: (preference: string) => Effect.Effect<void>;
  readonly revealConfig: () => Effect.Effect<void>;
  readonly openConfigInEditor: () => Effect.Effect<void>;
  readonly importExternalServers: () => Effect.Effect<number | null>;
  readonly generateToken: () => Effect.Effect<Redacted.Redacted<string>>;
}

export interface SettingsCallbacks {
  readonly commitGatewayMutation: (mutation: GatewayMutationValue) => void;
  readonly clearError: () => void;
  readonly dismissOperationalError: () => void;
  readonly setShowToken: (show: boolean) => void;
  readonly openKeyMigration: () => void;
  readonly changeLanguage: (preference: string) => void;
  readonly changeAppearance: (preference: string) => void;
  readonly revealConfig: () => void;
  readonly openConfigInEditor: () => void;
  readonly importExternalServers: () => Promise<number | null>;
  readonly generateToken: () => string;
}

export class SettingsActions extends Context.Service<SettingsActions, SettingsActionsService>()(
  'mcp-gateway/settings/SettingsActions',
) {
  static readonly fromRef = (ref: { readonly current: SettingsCallbacks }) =>
    Layer.succeed(SettingsActions, {
      commitGatewayMutation: (mutation) =>
        Effect.sync(() => {
          ref.current.commitGatewayMutation(mutation);
        }),
      clearError: () =>
        Effect.sync(() => {
          ref.current.clearError();
        }),
      dismissOperationalError: () =>
        Effect.sync(() => {
          ref.current.dismissOperationalError();
        }),
      setShowToken: (show) =>
        Effect.sync(() => {
          ref.current.setShowToken(show);
        }),
      openKeyMigration: () =>
        Effect.sync(() => {
          ref.current.openKeyMigration();
        }),
      changeLanguage: (preference) =>
        Effect.sync(() => {
          ref.current.changeLanguage(preference);
        }),
      changeAppearance: (preference) =>
        Effect.sync(() => {
          ref.current.changeAppearance(preference);
        }),
      revealConfig: () =>
        Effect.sync(() => {
          ref.current.revealConfig();
        }),
      openConfigInEditor: () =>
        Effect.sync(() => {
          ref.current.openConfigInEditor();
        }),
      importExternalServers: () => Effect.promise(() => ref.current.importExternalServers()),
      generateToken: () => Effect.sync(() => Redacted.make(ref.current.generateToken())),
    });

  static readonly noop = Layer.succeed(SettingsActions, {
    commitGatewayMutation: () => Effect.void,
    clearError: () => Effect.void,
    dismissOperationalError: () => Effect.void,
    setShowToken: () => Effect.void,
    openKeyMigration: () => Effect.void,
    changeLanguage: () => Effect.void,
    changeAppearance: () => Effect.void,
    revealConfig: () => Effect.void,
    openConfigInEditor: () => Effect.void,
    importExternalServers: () => Effect.succeed(null),
    generateToken: () => Effect.succeed(Redacted.make('0'.repeat(64))),
  });
}
