import { Redacted, Schema } from 'effect';

import {
  DocumentSchema,
  ServerEditorStateSchema,
} from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import type { AppSnapshot, UpdateStatus } from '@mcp-gateway/shared/rpc';
import type { GatewayErrorCode } from '@mcp-gateway/shared/types';

export const TabSchema = Schema.Literals(['overview', 'settings', 'logs']);
export type Tab = typeof TabSchema.Type;

export const ConfigFormatSchema = Schema.Literals(['json', 'jsonc']);

export const NetworkKindSchema = Schema.Literals(['loopback', 'lan', 'tailscale', 'tunnel']);

export const GatewayErrorCodeSchema = Schema.Literals([
  'InvalidConfig',
  'KeyUnavailable',
  'KeySetupFailed',
  'AmbiguousConfig',
  'UnsafeFile',
  'ConfigIO',
  'StaleRevision',
  'ConfigLocked',
  'NetworkPolicy',
  'BackendFailure',
  'ListenerFailure',
  'ShutdownFailure',
  'Cancelled',
  'Closed',
] satisfies readonly GatewayErrorCode[]);

export const VisibleErrorSchema = Schema.Struct({
  occurrenceId: Schema.String,
  code: GatewayErrorCodeSchema,
  message: Schema.String,
});

export type VisibleErrorValue = typeof VisibleErrorSchema.Type;

export const InterfaceChoiceSchema = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
  netmask: Schema.String,
  kind: NetworkKindSchema,
});

export const KeyMigrationSchema = Schema.Struct({
  gateway: Schema.Boolean,
  servers: Schema.Array(Schema.String),
});

export type KeyMigrationValue = typeof KeyMigrationSchema.Type;

export const ServerSnapshotSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(['stdio', 'http']),
  endpoint: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.Literals(['stopped', 'mounted', 'error', 'disabled']),
  error: Schema.NullOr(VisibleErrorSchema),
});

export const GatewaySnapshotRedactedSchema = Schema.Struct({
  configPath: Schema.String,
  configFormat: ConfigFormatSchema,
  /** Redacted so DevTools MCP state and event logs never expose plaintext credentials. */
  configText: Schema.Redacted(Schema.String),
  revision: Schema.String,
  running: Schema.Boolean,
  interfaces: Schema.Array(InterfaceChoiceSchema),
  network: Schema.NullOr(NetworkKindSchema),
  keyMigration: KeyMigrationSchema,
  servers: Schema.Array(ServerSnapshotSchema),
  configError: Schema.NullOr(VisibleErrorSchema),
  operationalError: Schema.NullOr(VisibleErrorSchema),
});

export type GatewaySnapshotRedacted = typeof GatewaySnapshotRedactedSchema.Type;

export const LoginStatusSchema = Schema.Struct({
  occurrenceId: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  supported: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

export const UpdatePhaseSchema = Schema.Literals([
  'idle',
  'checking',
  'available',
  'downloading',
  'ready',
  'restarting',
  'error',
]);

export const UpdateDownloadProgressSchema = Schema.Struct({
  percent: Schema.NullOr(Schema.Number),
  bytesDownloaded: Schema.Number,
  totalBytes: Schema.NullOr(Schema.Number),
});

export const UpdateStatusSchema = Schema.Struct({
  supported: Schema.Boolean,
  automaticUpdates: Schema.Boolean,
  installedVersion: Schema.NullOr(Schema.String),
  availableVersion: Schema.NullOr(Schema.String),
  phase: UpdatePhaseSchema,
  progressPercent: Schema.optional(Schema.NullOr(Schema.Number)),
  downloadedBytes: Schema.optional(Schema.NullOr(Schema.Number)),
  totalBytes: Schema.optional(Schema.NullOr(Schema.Number)),
  downloadProgress: Schema.optional(Schema.NullOr(UpdateDownloadProgressSchema)),
  error: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
});

export type UpdateStatusValue = typeof UpdateStatusSchema.Type;

export const LanguageStateSchema = Schema.Struct({
  preference: Schema.String,
  locale: Schema.String,
  available: Schema.Array(Schema.String),
});

export const AppearancePreferenceSchema = Schema.Literals(['system', 'light', 'dark']);

export const AppSnapshotRedactedSchema = Schema.Struct({
  gateway: GatewaySnapshotRedactedSchema,
  login: LoginStatusSchema,
  update: UpdateStatusSchema,
  whatsNew: Schema.NullOr(Schema.String),
  keyReminder: Schema.Boolean,
  language: LanguageStateSchema,
  appearance: AppearancePreferenceSchema,
});

export type AppSnapshotRedacted = typeof AppSnapshotRedactedSchema.Type;

export const MenuCommandSchema = Schema.Literals([
  'tab:overview',
  'tab:logs',
  'tab:settings',
  'tab:raw-config',
  'server:add',
  'updates:open',
  'gateway:reload',
]);

export const ActiveModalSchema = Schema.NullOr(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('serverEditor'),
      editor: ServerEditorStateSchema,
    }),
    Schema.Struct({
      kind: Schema.Literal('keyMigration'),
    }),
    Schema.Struct({
      kind: Schema.Literal('updates'),
    }),
  ]),
);

export type ActiveModal = typeof ActiveModalSchema.Type;

export const KeyMigrationStatusSchema = Schema.Literals(['idle', 'moving', 'done', 'failed']);
export type KeyMigrationStatus = typeof KeyMigrationStatusSchema.Type;

export const ImportOutcomeSchema = Schema.Struct({
  seq: Schema.Number,
  count: Schema.Number,
});

export const AppModel = Schema.Struct({
  locale: Schema.String,
  title: Schema.String,
  snapshot: Schema.NullOr(AppSnapshotRedactedSchema),
  doc: Schema.NullOr(DocumentSchema),
  editSequence: Schema.Number,
  generation: Schema.Number,
  error: Schema.NullOr(Schema.String),
  dismissedOpErrorId: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
  updateBusy: Schema.Boolean,
  activeModal: ActiveModalSchema,
  editorError: Schema.NullOr(Schema.String),
  keyMigrationStatus: KeyMigrationStatusSchema,
  lastImport: Schema.NullOr(ImportOutcomeSchema),
  showToken: Schema.Boolean,
  rawOpen: Schema.Boolean,
  whatsNewClosed: Schema.Boolean,
  updatesRequested: Schema.Boolean,
  tab: TabSchema,
});

export type AppModelValue = typeof AppModel.Type;

export const toRedactedSnapshot = (snapshot: AppSnapshot): AppSnapshotRedacted => ({
  gateway: {
    configPath: snapshot.gateway.configPath,
    configFormat: snapshot.gateway.configFormat,
    configText: Redacted.make(snapshot.gateway.configText),
    revision: snapshot.gateway.revision,
    running: snapshot.gateway.running,
    interfaces: snapshot.gateway.interfaces.map((item) => ({ ...item })),
    network: snapshot.gateway.network,
    keyMigration: {
      gateway: snapshot.gateway.keyMigration.gateway,
      servers: [...snapshot.gateway.keyMigration.servers],
    },
    servers: snapshot.gateway.servers.map((server) => ({
      ...server,
      error: server.error ? { ...server.error } : null,
    })),
    configError: snapshot.gateway.configError ? { ...snapshot.gateway.configError } : null,
    operationalError: snapshot.gateway.operationalError
      ? { ...snapshot.gateway.operationalError }
      : null,
  },
  login: { ...snapshot.login },
  update: toUpdateStatusValue(snapshot.update),
  whatsNew: snapshot.whatsNew,
  keyReminder: snapshot.keyReminder,
  language: {
    preference: snapshot.language.preference,
    locale: snapshot.language.locale,
    available: [...snapshot.language.available],
  },
  appearance: snapshot.appearance,
});

export const toUpdateStatusValue = (update: UpdateStatus): UpdateStatusValue => ({
  supported: update.supported,
  automaticUpdates: update.automaticUpdates,
  installedVersion: update.installedVersion,
  availableVersion: update.availableVersion,
  phase: update.phase,
  ...(update.progressPercent !== undefined ? { progressPercent: update.progressPercent } : {}),
  ...(update.downloadedBytes !== undefined ? { downloadedBytes: update.downloadedBytes } : {}),
  ...(update.totalBytes !== undefined ? { totalBytes: update.totalBytes } : {}),
  ...(update.downloadProgress !== undefined
    ? {
        downloadProgress: update.downloadProgress ? { ...update.downloadProgress } : null,
      }
    : {}),
  error: update.error,
  checkedAt: update.checkedAt,
});
