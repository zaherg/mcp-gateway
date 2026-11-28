import { Command, Component, Subscription, UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Effect, Layer, Redacted, Schema, Stream } from 'effect';

import {
  renderConfigBlockerBar,
  renderGatewayToggle,
  renderShell,
  renderSidebarUpdates,
} from '@mcp-gateway/mainview/effect-app/chrome';
import {
  applyIncomingSnapshot,
  applyOperationSuccess,
  buildCommitPayload,
  cleanDocFromSnapshot,
  computeDerivedState,
  initialAppModel,
  planServerApply,
  resolveUpdatesRequest,
} from '@mcp-gateway/mainview/effect-app/logic';
import {
  AppearancePreferenceSchema,
  AppModel,
  type AppModelValue,
  AppSnapshotRedactedSchema,
  KeyMigrationSchema,
  MenuCommandSchema,
  TabSchema,
  UpdateStatusSchema,
} from '@mcp-gateway/mainview/effect-app/schemas';
import { GatewayRpc, WindowEnv } from '@mcp-gateway/mainview/effect-app/services';
import { KeyMigrationView } from '@mcp-gateway/mainview/effect-dialogs/KeyMigrationView';
import { ServerEditorView } from '@mcp-gateway/mainview/effect-dialogs/ServerEditorView';
import {
  bearPreset,
  DocumentSchema,
  editorFromServer,
  emptyEditor,
  ServerEditorStateSchema,
} from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import { WhatsNewView } from '@mcp-gateway/mainview/effect-dialogs/WhatsNewView';
import { LogsCommandLayers, LogsView } from '@mcp-gateway/mainview/effect-logs/LogsView';
import { LogsDom, LogsRpc } from '@mcp-gateway/mainview/effect-logs/services';
import {
  OverviewCommandLayers,
  OverviewView,
} from '@mcp-gateway/mainview/effect-overview/OverviewView';
import {
  RawConfigCommandLayers,
  RawConfigView,
} from '@mcp-gateway/mainview/effect-raw-config/RawConfigView';
import { SettingsView } from '@mcp-gateway/mainview/effect-settings/SettingsView';
import {
  applyGatewayMutation,
  GatewayMutation,
} from '@mcp-gateway/mainview/effect-settings/services';
import { iconActivity, renderModal } from '@mcp-gateway/mainview/effect-ui';
import { UpdatesView } from '@mcp-gateway/mainview/effect-updates/UpdatesView';
import {
  CATALOG_LOCALES,
  type Locale,
  localeTag,
  parseLanguagePreference,
  resolveLocale,
  translator,
} from '@mcp-gateway/shared/i18n';
import { needsLoginRetry, parseAppearancePreference } from '@mcp-gateway/shared/rpc';
import changelog from '../../../CHANGELOG.md?raw';

export const GatewayOpActionSchema = UiSchema.TaggedEnum({
  Start: {},
  Stop: {},
  SaveConfig: {
    text: Schema.Redacted(Schema.String),
    expectedRevision: Schema.String,
    closeEditorOnSuccess: Schema.Boolean,
  },
  RevealConfig: {},
  OpenConfigInEditor: {},
  ImportExternalServers: {
    expectedRevision: Schema.String,
  },
  DismissKeyReminder: {},
  MigrateKeys: {
    gateway: Schema.Boolean,
    servers: Schema.Array(Schema.String),
    expectedRevision: Schema.String,
  },
  SetLanguage: {
    preference: Schema.String,
  },
  SetAppearance: {
    preference: AppearancePreferenceSchema,
  },
  UpdatesRestart: {},
});

export const UpdateOpActionSchema = UiSchema.TaggedEnum({
  Check: {},
  Install: {},
  SetAutomatic: { automatic: Schema.Boolean },
});

export const DiscardPurposeSchema = Schema.Literals(['discardRaw', 'reloadMenu', 'updateRestart']);

export const AppMessage = UiSchema.TaggedEnum({
  Bootstrapped: { locale: Schema.String, title: Schema.String },
  InitialSnapshotLoaded: {
    startedGeneration: Schema.Number,
    startedEditSeq: Schema.Number,
    ok: Schema.Boolean,
    snapshot: Schema.NullOr(AppSnapshotRedactedSchema),
    errorKind: Schema.NullOr(Schema.Literals(['rpc', 'bridge'])),
    errorMessage: Schema.NullOr(Schema.String),
  },
  SnapshotReceived: { snapshot: AppSnapshotRedactedSchema },
  MenuCommandReceived: { command: MenuCommandSchema },
  SystemAppearanceChanged: { scheme: Schema.Literals(['light', 'dark']) },
  GatewayOpFinished: {
    ok: Schema.Boolean,
    saved: Schema.Boolean,
    draft: Schema.Boolean,
    startedEditSeq: Schema.Number,
    submittedText: Schema.NullOr(Schema.Redacted(Schema.String)),
    snapshot: Schema.NullOr(AppSnapshotRedactedSchema),
    importedCount: Schema.NullOr(Schema.Number),
    closeEditorOnSuccess: Schema.Boolean,
    keyMigrationOp: Schema.Boolean,
    errorKind: Schema.NullOr(Schema.Literals(['rpc', 'bridge'])),
    errorMessage: Schema.NullOr(Schema.String),
  },
  UpdateOpFinished: {
    ok: Schema.Boolean,
    update: Schema.NullOr(UpdateStatusSchema),
    errorKind: Schema.NullOr(Schema.Literals(['rpc', 'bridge'])),
    errorMessage: Schema.NullOr(Schema.String),
  },
  DiscardConfirmed: {
    purpose: DiscardPurposeSchema,
    ok: Schema.Boolean,
    confirmed: Schema.Boolean,
    errorKind: Schema.NullOr(Schema.Literals(['rpc', 'bridge'])),
    errorMessage: Schema.NullOr(Schema.String),
  },
  ReloadFromMenuFinished: {
    ok: Schema.Boolean,
    snapshot: Schema.NullOr(AppSnapshotRedactedSchema),
  },
  DeleteServerConfirmed: {
    name: Schema.String,
    ok: Schema.Boolean,
    confirmed: Schema.Boolean,
  },
  // User / child-component actions
  SelectedTab: { tab: TabSchema },
  OpenedRawConfigFromBlocker: {},
  ToggledRawOpen: { open: Schema.Boolean },
  ToggledShowToken: { show: Schema.Boolean },
  ChangedDoc: { doc: DocumentSchema },
  ReloadedFromDisk: {},
  RequestedDiscardRawConfig: {},
  RequestedSaveRawConfig: {},
  DismissedError: {},
  DismissedOperationalError: {},
  DismissedEditorError: {},
  ReportedError: { message: Schema.String },
  RequestedStartGateway: {},
  RequestedStopGateway: {},
  CommittedGatewayMutation: { mutation: GatewayMutation },
  OpenedServerEditor: { name: Schema.NullOr(Schema.String), bearPreset: Schema.Boolean },
  ChangedServerEditor: { editor: ServerEditorStateSchema },
  SubmittedServerEditor: {},
  ClosedModal: {},
  OpenedKeyMigration: {},
  SubmittedKeyMigration: { slots: KeyMigrationSchema },
  KeptKeysInFile: {},
  OpenedUpdatesModal: {},
  RequestedUpdateCheck: {},
  RequestedUpdateInstall: {},
  RequestedToggleAutomaticUpdates: { automatic: Schema.Boolean },
  RequestedUpdateRestart: {},
  ClosedWhatsNew: {},
  ToggledServer: { name: Schema.String, disabled: Schema.Boolean },
  RequestedDeleteServer: { name: Schema.String },
  ChangedLanguage: { preference: Schema.String },
  ChangedAppearance: { preference: Schema.String },
  RequestedRevealConfig: {},
  RequestedOpenConfigInEditor: {},
  RequestedImportExternalServers: {},
  RequestedDismissKeyReminder: {},
});

export class BootstrapWindow extends Command.Service<BootstrapWindow>()(
  'mcp-gateway/app/BootstrapWindow',
  { args: {}, success: AppMessage },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const env = yield* WindowEnv;
      return () =>
        Effect.gen(function* () {
          const languages = yield* env.initialLanguages();
          const title = yield* env.appTitle();
          const locale = resolveLocale(languages);
          yield* env.syncLang(localeTag(locale));
          yield* env.syncAppearance('system');
          return AppMessage.Bootstrapped({ locale, title });
        });
    }),
  );
}

export class LoadInitialSnapshot extends Command.Service<LoadInitialSnapshot>()(
  'mcp-gateway/app/LoadInitialSnapshot',
  {
    args: { startedGeneration: Schema.Number, startedEditSeq: Schema.Number },
    success: AppMessage,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ startedGeneration, startedEditSeq }) =>
        rpc.snapshot().pipe(
          Effect.map((outcome) =>
            outcome.ok
              ? AppMessage.InitialSnapshotLoaded({
                  startedGeneration,
                  startedEditSeq,
                  ok: true,
                  snapshot: outcome.value,
                  errorKind: null,
                  errorMessage: null,
                })
              : AppMessage.InitialSnapshotLoaded({
                  startedGeneration,
                  startedEditSeq,
                  ok: false,
                  snapshot: null,
                  errorKind: outcome.error.kind,
                  errorMessage:
                    outcome.error.kind === 'rpc'
                      ? `${outcome.error.code}: ${outcome.error.message}`
                      : outcome.error.message,
                }),
          ),
        );
    }),
  );
}

export class RunGatewayOperation extends Command.Service<RunGatewayOperation>()(
  'mcp-gateway/app/RunGatewayOperation',
  {
    args: {
      action: GatewayOpActionSchema,
      saved: Schema.Boolean,
      draft: Schema.Boolean,
      startedEditSeq: Schema.Number,
      submittedText: Schema.NullOr(Schema.Redacted(Schema.String)),
    },
    success: AppMessage,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ action, saved, draft, startedEditSeq, submittedText }) => {
        const closeEditorOnSuccess =
          action._tag === 'SaveConfig' ? action.closeEditorOnSuccess : false;
        const keyMigrationOp = action._tag === 'MigrateKeys';
        const fail = (kind: 'rpc' | 'bridge', message: string) =>
          AppMessage.GatewayOpFinished({
            ok: false,
            saved,
            draft,
            startedEditSeq,
            submittedText,
            snapshot: null,
            importedCount: null,
            closeEditorOnSuccess,
            keyMigrationOp,
            errorKind: kind,
            errorMessage: message,
          });
        const succeed = (
          snapshot: typeof AppSnapshotRedactedSchema.Type | null,
          importedCount: number | null = null,
        ) =>
          AppMessage.GatewayOpFinished({
            ok: true,
            saved,
            draft,
            startedEditSeq,
            submittedText,
            snapshot,
            importedCount,
            closeEditorOnSuccess,
            keyMigrationOp,
            errorKind: null,
            errorMessage: null,
          });
        const fromOutcome = <T>(
          effect: Effect.Effect<
            | { readonly ok: true; readonly value: T }
            | {
                readonly ok: false;
                readonly error: {
                  readonly kind: 'rpc' | 'bridge';
                  readonly code: string;
                  readonly message: string;
                };
              }
          >,
          onOk: (value: T) => typeof AppMessage.Type,
        ) =>
          effect.pipe(
            Effect.map((outcome) =>
              outcome.ok
                ? onOk(outcome.value)
                : fail(
                    outcome.error.kind,
                    outcome.error.kind === 'rpc'
                      ? `${outcome.error.code}: ${outcome.error.message}`
                      : outcome.error.message,
                  ),
            ),
          );

        switch (action._tag) {
          case 'Start':
            return fromOutcome(rpc.start(), (snapshot) => succeed(snapshot));
          case 'Stop':
            return fromOutcome(rpc.stop(), (snapshot) => succeed(snapshot));
          case 'SaveConfig':
            return fromOutcome(
              rpc.saveConfig({
                text: action.text,
                expectedRevision: action.expectedRevision,
              }),
              (snapshot) => succeed(snapshot),
            );
          case 'RevealConfig':
            return fromOutcome(rpc.revealConfig(), () => succeed(null));
          case 'OpenConfigInEditor':
            return fromOutcome(rpc.openConfigInEditor(), () => succeed(null));
          case 'ImportExternalServers':
            return fromOutcome(
              rpc.importExternalServers({ expectedRevision: action.expectedRevision }),
              ({ snapshot, importedCount }) => succeed(snapshot, importedCount),
            );
          case 'DismissKeyReminder':
            return fromOutcome(rpc.dismissKeyReminder(), (snapshot) => succeed(snapshot));
          case 'MigrateKeys':
            return fromOutcome(
              rpc.migrateKeys({
                gateway: action.gateway,
                servers: action.servers,
                expectedRevision: action.expectedRevision,
              }),
              (snapshot) => succeed(snapshot),
            );
          case 'SetLanguage': {
            const pref = parseLanguagePreference(action.preference, CATALOG_LOCALES);
            if (!pref) return Effect.succeed(succeed(null));
            return fromOutcome(rpc.setLanguage({ preference: pref }), (snapshot) =>
              succeed(snapshot),
            );
          }
          case 'SetAppearance':
            return fromOutcome(rpc.setAppearance({ preference: action.preference }), (snapshot) =>
              succeed(snapshot),
            );
          case 'UpdatesRestart':
            return fromOutcome(rpc.updatesRestart(), () => succeed(null));
        }
      };
    }),
  );
}

export class RunUpdateOperation extends Command.Service<RunUpdateOperation>()(
  'mcp-gateway/app/RunUpdateOperation',
  {
    args: { action: UpdateOpActionSchema },
    success: AppMessage,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ action }) => {
        const call =
          action._tag === 'Check'
            ? rpc.updatesCheck()
            : action._tag === 'Install'
              ? rpc.updatesInstall()
              : rpc.updatesSetAutomatic({ automatic: action.automatic });
        return call.pipe(
          Effect.map((outcome) =>
            outcome.ok
              ? AppMessage.UpdateOpFinished({
                  ok: true,
                  update: outcome.value,
                  errorKind: null,
                  errorMessage: null,
                })
              : AppMessage.UpdateOpFinished({
                  ok: false,
                  update: null,
                  errorKind: outcome.error.kind,
                  errorMessage:
                    outcome.error.kind === 'rpc'
                      ? `${outcome.error.code}: ${outcome.error.message}`
                      : outcome.error.message,
                }),
          ),
        );
      };
    }),
  );
}

export class ConfirmDiscard extends Command.Service<ConfirmDiscard>()(
  'mcp-gateway/app/ConfirmDiscard',
  { args: { purpose: DiscardPurposeSchema }, success: AppMessage },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ purpose }) =>
        rpc.confirmDiscard().pipe(
          Effect.map((outcome) =>
            outcome.ok
              ? AppMessage.DiscardConfirmed({
                  purpose,
                  ok: true,
                  confirmed: outcome.value,
                  errorKind: null,
                  errorMessage: null,
                })
              : AppMessage.DiscardConfirmed({
                  purpose,
                  ok: false,
                  confirmed: false,
                  errorKind: outcome.error.kind,
                  errorMessage:
                    outcome.error.kind === 'rpc'
                      ? `${outcome.error.code}: ${outcome.error.message}`
                      : outcome.error.message,
                }),
          ),
        );
    }),
  );
}

export class ReloadSnapshotFromMenu extends Command.Service<ReloadSnapshotFromMenu>()(
  'mcp-gateway/app/ReloadSnapshotFromMenu',
  { args: {}, success: AppMessage },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return () =>
        rpc
          .snapshot()
          .pipe(
            Effect.map((outcome) =>
              outcome.ok
                ? AppMessage.ReloadFromMenuFinished({ ok: true, snapshot: outcome.value })
                : AppMessage.ReloadFromMenuFinished({ ok: false, snapshot: null }),
            ),
          );
    }),
  );
}

export class ConfirmDeleteServer extends Command.Service<ConfirmDeleteServer>()(
  'mcp-gateway/app/ConfirmDeleteServer',
  { args: { name: Schema.String }, success: AppMessage },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ name }) =>
        rpc.confirmDeleteServer({ name }).pipe(
          Effect.map((outcome) =>
            AppMessage.DeleteServerConfirmed({
              name,
              ok: outcome.ok,
              confirmed: outcome.ok && outcome.value,
            }),
          ),
        );
    }),
  );
}

export class DismissWhatsNew extends Command.Service<DismissWhatsNew>()(
  'mcp-gateway/app/DismissWhatsNew',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return () => rpc.dismissWhatsNew().pipe(Effect.as(Component.noop));
    }),
  );
}

export class SyncUnsavedChecker extends Command.Service<SyncUnsavedChecker>()(
  'mcp-gateway/app/SyncUnsavedChecker',
  { args: { dirty: Schema.Boolean } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ dirty }) =>
        rpc.setUnsavedRawConfigChecker(() => dirty).pipe(Effect.as(Component.noop));
    }),
  );
}

export class SyncWindowDom extends Command.Service<SyncWindowDom>()(
  'mcp-gateway/app/SyncWindowDom',
  {
    args: {
      langTag: Schema.NullOr(Schema.String),
      appearance: Schema.NullOr(AppearancePreferenceSchema),
      scrollTop: Schema.Boolean,
      focusUpdatesTrigger: Schema.Boolean,
    },
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const env = yield* WindowEnv;
      return ({ langTag, appearance, scrollTop, focusUpdatesTrigger }) =>
        Effect.gen(function* () {
          if (langTag !== null) yield* env.syncLang(langTag);
          if (appearance !== null) yield* env.syncAppearance(appearance);
          if (scrollTop) yield* env.scrollMainTop();
          if (focusUpdatesTrigger) yield* env.focusUpdatesTrigger();
        }).pipe(Effect.as(Component.noop));
    }),
  );
}

export const AppCommandLayers = Layer.mergeAll(
  BootstrapWindow.layer,
  LoadInitialSnapshot.layer,
  RunGatewayOperation.layer,
  RunUpdateOperation.layer,
  ConfirmDiscard.layer,
  ReloadSnapshotFromMenu.layer,
  ConfirmDeleteServer.layer,
  DismissWhatsNew.layer,
  SyncUnsavedChecker.layer,
  SyncWindowDom.layer,
);

/** All command and leaf service layers required by `AppView` and its children (requires `GatewayRpc | WindowEnv`). */
export const AppLiveLayers = Layer.mergeAll(
  AppCommandLayers,
  OverviewCommandLayers,
  RawConfigCommandLayers,
  LogsCommandLayers.pipe(
    Layer.provide(Layer.mergeAll(LogsRpc.fromGatewayRpc, LogsDom.fromDocument)),
  ),
);

const resolveTranslator = (locale: string) => translator(locale as Locale);

const finishTransition = (
  prev: AppModelValue,
  nextModel: AppModelValue,
  options: { readonly scrollTop?: boolean } = {},
) => {
  const { model: resolved, focusUpdatesTrigger } = resolveUpdatesRequest(nextModel, changelog);
  const commands: Array<Command.Command<typeof AppMessage.Type, never>> = [];
  const prevDirty = prev.doc?.dirty ?? false;
  const nextDirty = resolved.doc?.dirty ?? false;
  if (prevDirty !== nextDirty) {
    commands.push(SyncUnsavedChecker.make({ dirty: nextDirty }) as never);
  }
  const langTag = prev.locale !== resolved.locale ? localeTag(resolved.locale as Locale) : null;
  const prevAppearance = prev.snapshot?.appearance ?? 'system';
  const nextAppearance = resolved.snapshot?.appearance ?? 'system';
  const appearance = prevAppearance !== nextAppearance ? nextAppearance : null;
  const scrollTop = Boolean(options.scrollTop);
  if (langTag !== null || appearance !== null || scrollTop || focusUpdatesTrigger) {
    commands.push(
      SyncWindowDom.make({
        langTag,
        appearance,
        scrollTop,
        focusUpdatesTrigger,
      }) as never,
    );
  }
  return { model: resolved, commands };
};

const launchGatewayOp = (
  prev: AppModelValue,
  nextBase: AppModelValue,
  action: typeof GatewayOpActionSchema.Type,
  options: {
    readonly saved?: boolean;
    readonly draft?: boolean;
    readonly submittedText?: Redacted.Redacted<string> | null;
  } = {},
) => {
  const saved = options.saved ?? false;
  const draft = options.draft ?? saved;
  const submittedText = options.submittedText ?? null;
  const nextModel: AppModelValue = {
    ...nextBase,
    busy: true,
    error: null,
    generation: nextBase.generation + 1,
  };
  const { model, commands } = finishTransition(prev, nextModel);
  const opCmd = RunGatewayOperation.make({
    action,
    saved,
    draft,
    startedEditSeq: nextBase.editSequence,
    submittedText,
  });
  return { model, commands: [...commands, opCmd] };
};

export const AppProps = Schema.Struct({});

export const AppView = Html.component({
  name: 'AppView',
  props: AppProps,
  model: AppModel,
  message: AppMessage,
}).make({
  init: ($) => {
    const model = initialAppModel();
    return $.set(model).run(
      BootstrapWindow.make(),
      LoadInitialSnapshot.make({ startedGeneration: 0, startedEditSeq: 0 }),
      SyncUnsavedChecker.make({ dirty: false }),
    );
  },
  subscriptions: ({ model }) => {
    const appearance = model.snapshot?.appearance ?? 'system';
    return [
      Subscription.make(
        'snapshot-changed',
        Stream.unwrap(
          Effect.gen(function* () {
            const rpc = yield* GatewayRpc;
            return rpc.subscribeSnapshot.pipe(
              Stream.map((snapshot) => AppMessage.SnapshotReceived({ snapshot })),
            );
          }),
        ),
      ),
      Subscription.make(
        'menu-command',
        Stream.unwrap(
          Effect.gen(function* () {
            const rpc = yield* GatewayRpc;
            return rpc.subscribeMenuCommand.pipe(
              Stream.map((command) => AppMessage.MenuCommandReceived({ command })),
            );
          }),
        ),
      ),
      appearance === 'system' &&
        Subscription.make(
          'system-appearance',
          Stream.unwrap(
            Effect.gen(function* () {
              const env = yield* WindowEnv;
              return env.subscribeColorScheme.pipe(
                Stream.map((scheme) => AppMessage.SystemAppearanceChanged({ scheme })),
              );
            }),
          ),
        ),
    ];
  },
  update: {
    Bootstrapped: ($, { locale, title }) =>
      $.evolve({
        title,
        locale: $.model.snapshot ? $.model.locale : locale,
      }),
    InitialSnapshotLoaded: (
      $,
      { startedGeneration, startedEditSeq, ok, snapshot, errorKind, errorMessage },
    ) => {
      if (startedGeneration !== $.model.generation) return $.model;
      if (!ok || !snapshot) {
        const t = resolveTranslator($.model.locale);
        return $.evolve({
          error:
            errorKind === 'rpc' && errorMessage !== null
              ? errorMessage
              : t('app.statusUnavailable'),
        });
      }
      const applied = applyIncomingSnapshot($.model, snapshot, startedEditSeq);
      const { model, commands } = finishTransition($.model, applied);
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    SnapshotReceived: ($, { snapshot }) => {
      const applied = applyIncomingSnapshot($.model, snapshot);
      const { model, commands } = finishTransition($.model, applied);
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    SystemAppearanceChanged: ($) =>
      $.run(
        SyncWindowDom.make({
          langTag: null,
          appearance: 'system',
          scrollTop: false,
          focusUpdatesTrigger: false,
        }),
      ),
    MenuCommandReceived: ($, { command }) => {
      const derived = computeDerivedState($.model, changelog);
      switch (command) {
        case 'tab:overview': {
          const { model, commands } = finishTransition(
            $.model,
            { ...$.model, tab: 'overview' },
            { scrollTop: $.model.tab !== 'overview' },
          );
          return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
        }
        case 'tab:logs': {
          const { model, commands } = finishTransition(
            $.model,
            { ...$.model, tab: 'logs' },
            { scrollTop: $.model.tab !== 'logs' },
          );
          return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
        }
        case 'tab:settings': {
          const { model, commands } = finishTransition(
            $.model,
            { ...$.model, tab: 'settings' },
            { scrollTop: $.model.tab !== 'settings' },
          );
          return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
        }
        case 'tab:raw-config': {
          const { model, commands } = finishTransition(
            $.model,
            { ...$.model, tab: 'settings', rawOpen: true },
            { scrollTop: $.model.tab !== 'settings' },
          );
          return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
        }
        case 'server:add': {
          if (!derived.config || derived.configurationLocked) return $.model;
          const nextBase: AppModelValue = {
            ...$.model,
            tab: 'overview',
            editorError: null,
            activeModal: { kind: 'serverEditor', editor: emptyEditor() },
          };
          const { model, commands } = finishTransition($.model, nextBase, {
            scrollTop: $.model.tab !== 'overview',
          });
          return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
        }
        case 'updates:open': {
          const { model, commands } = finishTransition($.model, {
            ...$.model,
            updatesRequested: true,
          });
          return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
        }
        case 'gateway:reload': {
          if ($.model.doc?.dirty) {
            return $.run(ConfirmDiscard.make({ purpose: 'reloadMenu' }));
          }
          return $.run(ReloadSnapshotFromMenu.make());
        }
      }
    },
    GatewayOpFinished: (
      $,
      {
        ok,
        saved,
        draft,
        startedEditSeq,
        submittedText,
        snapshot,
        importedCount,
        closeEditorOnSuccess,
        keyMigrationOp,
        errorKind,
        errorMessage,
      },
    ) => {
      const t = resolveTranslator($.model.locale);
      if (!ok) {
        const failure =
          errorKind === 'rpc' && errorMessage !== null
            ? draft
              ? t('operations.saveFailed', { error: errorMessage })
              : errorMessage
            : t('operations.nativeFailed');
        const nextBase: AppModelValue = {
          ...$.model,
          busy: false,
          generation: $.model.generation + 1,
          error: failure,
          keyMigrationStatus: keyMigrationOp ? 'failed' : $.model.keyMigrationStatus,
        };
        const { model, commands } = finishTransition($.model, nextBase);
        return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
      }
      let nextBase: AppModelValue = snapshot
        ? applyOperationSuccess($.model, snapshot, { saved, startedEditSeq, submittedText })
        : $.model;
      nextBase = {
        ...nextBase,
        busy: false,
        generation: nextBase.generation + 1,
        activeModal:
          closeEditorOnSuccess && nextBase.activeModal?.kind === 'serverEditor'
            ? null
            : nextBase.activeModal,
        keyMigrationStatus: keyMigrationOp ? 'done' : nextBase.keyMigrationStatus,
        lastImport:
          importedCount !== null
            ? { seq: (nextBase.lastImport?.seq ?? 0) + 1, count: importedCount }
            : nextBase.lastImport,
      };
      const { model, commands } = finishTransition($.model, nextBase);
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    UpdateOpFinished: ($, { ok, update, errorKind, errorMessage }) => {
      const t = resolveTranslator($.model.locale);
      if (!ok || !update) {
        const nextBase: AppModelValue = {
          ...$.model,
          updateBusy: false,
          error:
            errorKind === 'rpc' && errorMessage !== null
              ? errorMessage
              : t('operations.updateFailed'),
        };
        const { model, commands } = finishTransition($.model, nextBase);
        return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
      }
      const nextBase: AppModelValue = {
        ...$.model,
        updateBusy: false,
        snapshot: $.model.snapshot ? { ...$.model.snapshot, update } : $.model.snapshot,
      };
      const { model, commands } = finishTransition($.model, nextBase);
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    DiscardConfirmed: ($, { purpose, ok, confirmed, errorKind, errorMessage }) => {
      if (!ok) {
        const t = resolveTranslator($.model.locale);
        return $.evolve({
          error:
            errorKind === 'rpc' && errorMessage !== null
              ? errorMessage
              : t('app.confirmUnavailable'),
        });
      }
      if (!confirmed) return $.model;
      const derived = computeDerivedState($.model, changelog);
      if (purpose === 'discardRaw') {
        if (derived.configurationLocked || !$.model.snapshot) return $.model;
        const nextBase: AppModelValue = {
          ...$.model,
          editSequence: $.model.editSequence + 1,
          doc: cleanDocFromSnapshot($.model.snapshot),
          error: null,
        };
        const { model, commands } = finishTransition($.model, nextBase);
        return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
      }
      if (purpose === 'reloadMenu') {
        return $.run(ReloadSnapshotFromMenu.make());
      }
      // purpose === 'updateRestart'
      if (derived.updateRestarting || $.model.snapshot?.update.phase !== 'ready') return $.model;
      const nextBase: AppModelValue = {
        ...$.model,
        activeModal: $.model.activeModal?.kind === 'updates' ? null : $.model.activeModal,
      };
      const { model, commands } = launchGatewayOp(
        $.model,
        nextBase,
        GatewayOpActionSchema.UpdatesRestart(),
      );
      return $.set(model).run(...commands);
    },
    ReloadFromMenuFinished: ($, { ok, snapshot }) => {
      if (!ok || !snapshot) return $.model;
      const nextBase: AppModelValue = {
        ...$.model,
        locale: snapshot.language.locale,
        snapshot,
        editSequence: $.model.editSequence + 1,
        doc: cleanDocFromSnapshot(snapshot),
        error: null,
      };
      const { model, commands } = finishTransition($.model, nextBase);
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    DeleteServerConfirmed: ($, { name, ok, confirmed }) => {
      if (!ok || !confirmed) return $.model;
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || !derived.config) return $.model;
      const servers = { ...derived.config.mcpServers };
      delete servers[name];
      const payload = buildCommitPayload($.model, { ...derived.config, mcpServers: servers });
      if (!payload) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.SaveConfig({
          text: payload.text,
          expectedRevision: payload.expectedRevision,
          closeEditorOnSuccess: false,
        }),
        { saved: true, draft: true, submittedText: $.model.doc?.text ?? null },
      );
      return $.set(model).run(...commands);
    },
    SelectedTab: ($, { tab }) => {
      const { model, commands } = finishTransition(
        $.model,
        { ...$.model, tab },
        { scrollTop: $.model.tab !== tab },
      );
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    OpenedRawConfigFromBlocker: ($) => {
      const { model, commands } = finishTransition(
        $.model,
        { ...$.model, tab: 'settings', rawOpen: true },
        { scrollTop: $.model.tab !== 'settings' },
      );
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    ToggledRawOpen: ($, { open }) => $.evolve({ rawOpen: open }),
    ToggledShowToken: ($, { show }) => $.evolve({ showToken: show }),
    ChangedDoc: ($, { doc }) => {
      const nextBase: AppModelValue = {
        ...$.model,
        editSequence: $.model.editSequence + 1,
        doc,
      };
      const { model, commands } = finishTransition($.model, nextBase);
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    ReloadedFromDisk: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || !$.model.snapshot) return $.model;
      const nextBase: AppModelValue = {
        ...$.model,
        editSequence: $.model.editSequence + 1,
        doc: cleanDocFromSnapshot($.model.snapshot),
        error: null,
      };
      const { model, commands } = finishTransition($.model, nextBase);
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    RequestedDiscardRawConfig: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || !derived.gateway) return $.model;
      return $.run(ConfirmDiscard.make({ purpose: 'discardRaw' }));
    },
    RequestedSaveRawConfig: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || !$.model.doc) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.SaveConfig({
          text: $.model.doc.text,
          expectedRevision: $.model.doc.revision,
          closeEditorOnSuccess: false,
        }),
        { saved: true, draft: true, submittedText: $.model.doc.text },
      );
      return $.set(model).run(...commands);
    },
    DismissedError: ($) => {
      const derived = computeDerivedState($.model, changelog);
      return $.evolve({
        error: null,
        dismissedOpErrorId: derived.rawOperationalError
          ? derived.rawOperationalError.occurrenceId
          : $.model.dismissedOpErrorId,
      });
    },
    DismissedOperationalError: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if (!derived.rawOperationalError) return $.model;
      return $.evolve({ dismissedOpErrorId: derived.rawOperationalError.occurrenceId });
    },
    DismissedEditorError: ($) => $.evolve({ editorError: null }),
    ReportedError: ($, { message }) => $.evolve({ error: message }),
    RequestedStartGateway: ($) => {
      const { model, commands } = launchGatewayOp($.model, $.model, GatewayOpActionSchema.Start());
      return $.set(model).run(...commands);
    },
    RequestedStopGateway: ($) => {
      const { model, commands } = launchGatewayOp($.model, $.model, GatewayOpActionSchema.Stop());
      return $.set(model).run(...commands);
    },
    CommittedGatewayMutation: ($, { mutation }) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || !derived.config) return $.model;
      const nextConfig = {
        ...derived.config,
        gateway: applyGatewayMutation(derived.config.gateway, mutation),
      };
      const payload = buildCommitPayload($.model, nextConfig);
      if (!payload) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.SaveConfig({
          text: payload.text,
          expectedRevision: payload.expectedRevision,
          closeEditorOnSuccess: false,
        }),
        { saved: true, draft: true, submittedText: $.model.doc?.text ?? null },
      );
      return $.set(model).run(...commands);
    },
    OpenedServerEditor: ($, { name, bearPreset: useBearPreset }) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked) return $.model;
      let nextEditor = emptyEditor();
      if (name && derived.config) {
        const server = derived.config.mcpServers[name];
        if (!server) return $.model;
        nextEditor = editorFromServer(name, server);
      } else if (useBearPreset) {
        nextEditor = { ...nextEditor, ...bearPreset() };
      }
      const { model, commands } = finishTransition($.model, {
        ...$.model,
        editorError: null,
        activeModal: { kind: 'serverEditor', editor: nextEditor },
      });
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    ChangedServerEditor: ($, { editor }) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || $.model.activeModal?.kind !== 'serverEditor') {
        return $.model;
      }
      return $.evolve({ activeModal: { kind: 'serverEditor', editor } });
    },
    SubmittedServerEditor: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if (
        derived.configurationLocked ||
        !derived.config ||
        $.model.activeModal?.kind !== 'serverEditor'
      ) {
        return $.model;
      }
      const t = resolveTranslator($.model.locale);
      const plan = planServerApply($.model.activeModal.editor, derived.config, t);
      if (!plan.ok) {
        return $.evolve({ editorError: plan.error });
      }
      const payload = buildCommitPayload($.model, plan.nextConfig, plan.rename);
      if (!payload) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.SaveConfig({
          text: payload.text,
          expectedRevision: payload.expectedRevision,
          closeEditorOnSuccess: true,
        }),
        { saved: true, draft: true, submittedText: $.model.doc?.text ?? null },
      );
      return $.set(model).run(...commands);
    },
    ClosedModal: ($) => {
      const { model, commands } = finishTransition($.model, {
        ...$.model,
        activeModal: null,
        keyMigrationStatus: 'idle',
      });
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    OpenedKeyMigration: ($) => {
      const { model, commands } = finishTransition($.model, {
        ...$.model,
        keyMigrationStatus: 'idle',
        activeModal: { kind: 'keyMigration' },
      });
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    SubmittedKeyMigration: ($, { slots }) => {
      const derived = computeDerivedState($.model, changelog);
      if ($.model.busy || derived.configurationLocked || !$.model.doc || derived.dirty) {
        return $.model;
      }
      const nextBase: AppModelValue = { ...$.model, keyMigrationStatus: 'moving' };
      const { model, commands } = launchGatewayOp(
        $.model,
        nextBase,
        GatewayOpActionSchema.MigrateKeys({
          gateway: slots.gateway,
          servers: [...slots.servers],
          expectedRevision: $.model.doc.revision,
        }),
        { saved: true, draft: false, submittedText: $.model.doc.text },
      );
      return $.set(model).run(...commands);
    },
    KeptKeysInFile: ($) => {
      const derived = computeDerivedState($.model, changelog);
      const closedBase: AppModelValue = {
        ...$.model,
        activeModal: null,
        keyMigrationStatus: 'idle',
      };
      if ($.model.busy || derived.configurationLocked) {
        const { model, commands } = finishTransition($.model, closedBase);
        return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
      }
      const { model, commands } = launchGatewayOp(
        $.model,
        closedBase,
        GatewayOpActionSchema.DismissKeyReminder(),
      );
      return $.set(model).run(...commands);
    },
    OpenedUpdatesModal: ($) => {
      const { model, commands } = finishTransition($.model, {
        ...$.model,
        updatesRequested: true,
      });
      return commands.length > 0 ? $.set(model).run(...commands) : $.set(model);
    },
    RequestedUpdateCheck: ($) => {
      if ($.model.updateBusy) return $.model;
      return $.evolve({ updateBusy: true, error: null }).run(
        RunUpdateOperation.make({ action: UpdateOpActionSchema.Check() }),
      );
    },
    RequestedUpdateInstall: ($) => {
      if ($.model.updateBusy) return $.model;
      return $.evolve({ updateBusy: true, error: null }).run(
        RunUpdateOperation.make({ action: UpdateOpActionSchema.Install() }),
      );
    },
    RequestedToggleAutomaticUpdates: ($, { automatic }) => {
      if ($.model.updateBusy) return $.model;
      return $.evolve({ updateBusy: true, error: null }).run(
        RunUpdateOperation.make({ action: UpdateOpActionSchema.SetAutomatic({ automatic }) }),
      );
    },
    RequestedUpdateRestart: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.updateRestarting || $.model.snapshot?.update.phase !== 'ready') return $.model;
      if ($.model.doc?.dirty) {
        return $.run(ConfirmDiscard.make({ purpose: 'updateRestart' }));
      }
      const nextBase: AppModelValue = {
        ...$.model,
        activeModal: $.model.activeModal?.kind === 'updates' ? null : $.model.activeModal,
      };
      const { model, commands } = launchGatewayOp(
        $.model,
        nextBase,
        GatewayOpActionSchema.UpdatesRestart(),
      );
      return $.set(model).run(...commands);
    },
    ClosedWhatsNew: ($) => {
      const { model, commands } = finishTransition($.model, {
        ...$.model,
        whatsNewClosed: true,
      });
      return $.set(model).run(...commands, DismissWhatsNew.make());
    },
    ToggledServer: ($, { name, disabled }) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || !derived.config || !$.model.doc || derived.dirty) {
        return $.model;
      }
      const server = derived.config.mcpServers[name];
      if (!server) return $.model;
      const nextConfig = {
        ...derived.config,
        mcpServers: {
          ...derived.config.mcpServers,
          [name]: { ...server, disabled },
        },
      };
      const payload = buildCommitPayload($.model, nextConfig);
      if (!payload) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.SaveConfig({
          text: payload.text,
          expectedRevision: payload.expectedRevision,
          closeEditorOnSuccess: false,
        }),
        { saved: true, draft: true, submittedText: $.model.doc.text },
      );
      return $.set(model).run(...commands);
    },
    RequestedDeleteServer: ($, { name }) => {
      const derived = computeDerivedState($.model, changelog);
      if (derived.configurationLocked || !derived.config) return $.model;
      return $.run(ConfirmDeleteServer.make({ name }));
    },
    ChangedLanguage: ($, { preference }) => {
      const derived = computeDerivedState($.model, changelog);
      if ($.model.busy || derived.configurationLocked) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.SetLanguage({ preference }),
      );
      return $.set(model).run(...commands);
    },
    ChangedAppearance: ($, { preference }) => {
      const derived = computeDerivedState($.model, changelog);
      const parsed = parseAppearancePreference(preference);
      if ($.model.busy || derived.configurationLocked || !parsed) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.SetAppearance({ preference: parsed }),
      );
      return $.set(model).run(...commands);
    },
    RequestedRevealConfig: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if ($.model.busy || derived.configurationLocked) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.RevealConfig(),
      );
      return $.set(model).run(...commands);
    },
    RequestedOpenConfigInEditor: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if ($.model.busy || derived.configurationLocked) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.OpenConfigInEditor(),
      );
      return $.set(model).run(...commands);
    },
    RequestedImportExternalServers: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if ($.model.busy || derived.configurationLocked || !$.model.doc || $.model.doc.dirty) {
        return $.model;
      }
      const expectedRevision = derived.gateway?.revision ?? $.model.doc.revision;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.ImportExternalServers({ expectedRevision }),
        { saved: true, draft: false, submittedText: $.model.doc.text },
      );
      return $.set(model).run(...commands);
    },
    RequestedDismissKeyReminder: ($) => {
      const derived = computeDerivedState($.model, changelog);
      if ($.model.busy || derived.configurationLocked) return $.model;
      const { model, commands } = launchGatewayOp(
        $.model,
        $.model,
        GatewayOpActionSchema.DismissKeyReminder(),
      );
      return $.set(model).run(...commands);
    },
  },
  view: (h, model) => {
    const t = resolveTranslator(model.locale);
    const derived = computeDerivedState(model, changelog);
    const {
      gateway,
      config,
      dirty,
      stale,
      filename,
      existingNames,
      operationalError,
      configurationLocked,
      updateState,
      updateRestarting,
      whatsNewPending,
      updatesTriggerDisabled,
    } = derived;
    const movable = gateway?.keyMigration;
    const hasMovableKeys = Boolean(movable && (movable.gateway || movable.servers.length > 0));
    const retryLogin = Boolean(
      model.snapshot &&
        config &&
        !gateway?.configError &&
        needsLoginRetry(model.snapshot.login, config.gateway.launchAtLogin ?? false),
    );

    const activeDialog = (() => {
      switch (model.activeModal?.kind) {
        case 'serverEditor':
          return ServerEditorView(h, {
            key: 'server-editor',
            props: {
              locale: model.locale,
              editor: model.activeModal.editor,
              existingNames: [...existingNames],
              editorError: model.editorError,
              configurationLocked,
            },
            onEmit: {
              ChangedEditor: ({ editor }) => AppMessage.ChangedServerEditor({ editor }),
              Submitted: () => AppMessage.SubmittedServerEditor(),
              Closed: () => AppMessage.ClosedModal(),
              DismissedError: () => AppMessage.DismissedEditorError(),
            },
          });
        case 'keyMigration':
          return model.snapshot
            ? KeyMigrationView(h, {
                key: 'key-migration',
                props: {
                  locale: model.locale,
                  slots: model.snapshot.gateway.keyMigration,
                  dirty,
                  busy: model.busy || configurationLocked,
                  status: model.keyMigrationStatus,
                  error: model.error,
                  filename,
                },
                onEmit: {
                  RequestedMove: ({ slots }) => AppMessage.SubmittedKeyMigration({ slots }),
                  RequestedKeep: () => AppMessage.KeptKeysInFile(),
                  RequestedClose: () => AppMessage.ClosedModal(),
                },
              })
            : null;
        case 'updates':
          return updateState?.supported && !updateRestarting
            ? renderModal(h, {
                titleId: 'updates-modal-title',
                title: t('common.updates'),
                closeLabel: t('common.closeDialog'),
                busy: model.busy || model.updateBusy,
                onClose: AppMessage.ClosedModal(),
                body: [
                  UpdatesView(h, {
                    key: 'updates',
                    props: {
                      locale: model.locale,
                      updateState,
                      busy: model.busy,
                      updateBusy: model.updateBusy,
                      configurationLocked,
                      error: model.error,
                    },
                    onEmit: {
                      RequestedDismissError: () => AppMessage.DismissedError(),
                      RequestedCheck: () => AppMessage.RequestedUpdateCheck(),
                      RequestedInstall: () => AppMessage.RequestedUpdateInstall(),
                      RequestedRestart: () => AppMessage.RequestedUpdateRestart(),
                      RequestedToggleAutomatic: ({ automatic }) =>
                        AppMessage.RequestedToggleAutomaticUpdates({ automatic }),
                    },
                  }),
                ],
              })
            : null;
        default:
          return whatsNewPending && model.snapshot?.whatsNew
            ? WhatsNewView(h, {
                key: 'whats-new',
                props: {
                  locale: model.locale,
                  version: model.snapshot.whatsNew,
                },
                onEmit: {
                  Closed: () => AppMessage.ClosedWhatsNew(),
                },
              })
            : null;
      }
    })();

    const overviewServers = config
      ? Object.entries(config.mcpServers).map(([name, server]) => {
          const live = gateway?.servers.find((item) => item.name === name);
          const status = live?.status ?? (server.disabled ? 'disabled' : 'stopped');
          const http = 'url' in server;
          return {
            name,
            transport: http ? ('http' as const) : ('stdio' as const),
            target: http ? server.url : server.command,
            disabled: Boolean(server.disabled),
            status,
            hasLive: live !== undefined,
            liveError: live?.error?.message ?? null,
          };
        })
      : [];

    const savedSettingsConfig = config
      ? {
          host: config.gateway.host,
          port: config.gateway.port,
          allowedPeers: config.gateway.allowedPeers ? [...config.gateway.allowedPeers] : null,
          token: config.gateway.token !== undefined ? Redacted.make(config.gateway.token) : null,
          tokenRef: config.gateway.tokenRef ?? null,
          launchAtLogin: Boolean(config.gateway.launchAtLogin),
          autoStart: Boolean(config.gateway.autoStart),
          keepAwake: Boolean(config.gateway.keepAwake),
        }
      : null;

    const mainBody =
      (!model.snapshot || !model.doc) && model.tab === 'logs'
        ? LogsView(h, {
            key: 'logs',
            props: { servers: [], locale: model.locale },
          })
        : !model.snapshot || !model.doc
          ? h.section
              .class('panel loading')
              .attr('aria-busy', 'true')
              .children(
                iconActivity(h, 'size-[22px]'),
                h.h2.children(t('app.connecting')),
                h.p.children(t('app.waiting')),
              )
          : h.fieldset
              .class('workspace')
              .disabled(model.busy)
              .children(
                model.tab === 'logs'
                  ? LogsView(h, {
                      key: 'logs',
                      props: {
                        servers: gateway?.servers.map((server) => server.name) ?? [],
                        locale: model.locale,
                      },
                    })
                  : model.tab === 'overview'
                    ? OverviewView(h, {
                        key: 'overview',
                        props: {
                          locale: model.locale,
                          hasConfig: config !== null,
                          dirty,
                          running: Boolean(gateway?.running),
                          revision: gateway?.revision ?? null,
                          listenerAddress: config
                            ? `${config.gateway.host}:${config.gateway.port}`
                            : null,
                          configurationLocked,
                          hasConfigError: Boolean(gateway?.configError),
                          configErrorCode: gateway?.configError?.code ?? null,
                          error: model.error,
                          operationalError: operationalError
                            ? { code: operationalError.code, message: operationalError.message }
                            : null,
                          keyReminder: Boolean(model.snapshot.keyReminder),
                          servers: overviewServers,
                        },
                        onEmit: {
                          DismissedError: () => AppMessage.DismissedError(),
                          DismissedOperationalError: () => AppMessage.DismissedOperationalError(),
                          DismissedKeyReminder: () => AppMessage.RequestedDismissKeyReminder(),
                          RequestedOpenKeyMigration: () => AppMessage.OpenedKeyMigration(),
                          RequestedOpenServerEditor: ({ name }) =>
                            AppMessage.OpenedServerEditor({ name, bearPreset: false }),
                          RequestedOpenBearPreset: () =>
                            AppMessage.OpenedServerEditor({ name: null, bearPreset: true }),
                          RequestedToggleServer: ({ name, disabled }) =>
                            AppMessage.ToggledServer({ name, disabled }),
                          RequestedDeleteServer: ({ name }) =>
                            AppMessage.RequestedDeleteServer({ name }),
                          ReportedError: ({ message }) => AppMessage.ReportedError({ message }),
                        },
                      })
                    : SettingsView(h, {
                        key: 'settings',
                        props: {
                          locale: model.locale,
                          filename,
                          hasSnapshot: true,
                          dirty,
                          busy: model.busy,
                          configurationLocked,
                          showToken: model.showToken,
                          error: model.error,
                          operationalError: operationalError
                            ? { code: operationalError.code, message: operationalError.message }
                            : null,
                          revision: gateway?.revision ?? null,
                          appearance: model.snapshot.appearance,
                          languagePreference: model.snapshot.language.preference,
                          availableLanguages: [...model.snapshot.language.available],
                          login: model.snapshot.login,
                          retryLogin,
                          interfaces: gateway
                            ? gateway.interfaces.map(({ name, address, kind }) => ({
                                name,
                                address,
                                kind,
                              }))
                            : [],
                          hasMovableKeys,
                          savedConfig: savedSettingsConfig,
                          lastImport: model.lastImport,
                        },
                        onEmit: {
                          DismissedError: () => AppMessage.DismissedError(),
                          DismissedOperationalError: () => AppMessage.DismissedOperationalError(),
                          CommittedGatewayMutation: ({ mutation }) =>
                            AppMessage.CommittedGatewayMutation({ mutation }),
                          ToggledShowToken: ({ show }) => AppMessage.ToggledShowToken({ show }),
                          RequestedOpenKeyMigration: () => AppMessage.OpenedKeyMigration(),
                          ChangedAppearance: ({ preference }) =>
                            AppMessage.ChangedAppearance({ preference }),
                          ChangedLanguage: ({ preference }) =>
                            AppMessage.ChangedLanguage({ preference }),
                          RequestedRevealConfig: () => AppMessage.RequestedRevealConfig(),
                          RequestedOpenConfigInEditor: () =>
                            AppMessage.RequestedOpenConfigInEditor(),
                          RequestedImportExternalServers: () =>
                            AppMessage.RequestedImportExternalServers(),
                        },
                      }),
                gateway
                  ? RawConfigView(h, {
                      key: 'raw-config',
                      props: {
                        locale: model.locale,
                        visible: model.tab === 'settings',
                        rawOpen: model.rawOpen,
                        locked: configurationLocked || model.busy,
                        format: gateway.configFormat,
                        filename,
                        configPath: gateway.configPath,
                        savedConfigText: gateway.configText,
                        doc: model.doc,
                        editSequence: model.editSequence,
                        lastImport: model.lastImport,
                      },
                      onEmit: {
                        ToggledRawOpen: ({ open }) => AppMessage.ToggledRawOpen({ open }),
                        ChangedDoc: ({ doc }) => AppMessage.ChangedDoc({ doc }),
                        RequestedRevealConfig: () => AppMessage.RequestedRevealConfig(),
                        RequestedOpenConfigInEditor: () => AppMessage.RequestedOpenConfigInEditor(),
                        RequestedImportExternal: () => AppMessage.RequestedImportExternalServers(),
                        RequestedDiscardRawConfig: () => AppMessage.RequestedDiscardRawConfig(),
                        RequestedSaveRawConfig: () => AppMessage.RequestedSaveRawConfig(),
                      },
                    })
                  : null,
              );

    return renderShell(h, {
      tab: model.tab,
      title: model.title,
      snapshot: model.snapshot,
      locale: model.locale,
      onSelectTab: (tab) => AppMessage.SelectedTab({ tab }),
      sidebarUpdates: renderSidebarUpdates(h, {
        updateState,
        disabled: updatesTriggerDisabled,
        locale: model.locale,
        onOpen: AppMessage.OpenedUpdatesModal(),
        onRestart: AppMessage.RequestedUpdateRestart(),
      }),
      gatewayToggle:
        model.snapshot && model.doc
          ? renderGatewayToggle(h, {
              gateway,
              dirty,
              configurationLocked: configurationLocked || model.busy,
              locale: model.locale,
              onStart: AppMessage.RequestedStartGateway(),
              onStop: AppMessage.RequestedStopGateway(),
            })
          : null,
      dialogs: activeDialog,
      children: [
        renderConfigBlockerBar(h, {
          configError: gateway?.configError,
          stale,
          disabled: configurationLocked || model.busy,
          locale: model.locale,
          onOpenRawConfig: AppMessage.OpenedRawConfigFromBlocker(),
          onReloadFromDisk: AppMessage.ReloadedFromDisk(),
        }),
        mainBody,
      ],
    });
  },
});
