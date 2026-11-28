import { UiSchema } from '@effect/ui';
import { Redacted, Schema } from 'effect';

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
