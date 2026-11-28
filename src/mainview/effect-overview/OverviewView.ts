import { Command, Subscription, UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Switch } from '@effect/ui-kit';
import { Effect, Layer, Schema, Stream } from 'effect';

import { GatewayRpc } from '@mcp-gateway/mainview/effect-app/services';
import {
  isTestOutdated,
  resolveTestBlockedKey,
  SERVER_STATUS,
  visibleTestForServer,
} from '@mcp-gateway/mainview/effect-overview/logic';
import {
  TestServerOutcome,
  type TestServerOutcomeValue,
} from '@mcp-gateway/mainview/effect-overview/services';
import {
  buttonClasses,
  iconCheck,
  iconCode2,
  iconCopy,
  iconLoader,
  iconPencil,
  iconPlugZap,
  iconServer,
  iconTrash,
  iconX,
  LocaleSchema,
  renderAlert,
  SWITCH_ROOT_CLASSES,
  SWITCH_THUMB_CLASSES,
} from '@mcp-gateway/mainview/effect-ui';
import { type Locale, translator } from '@mcp-gateway/shared/i18n';

export const ServerRowStatusSchema = Schema.Literals(['mounted', 'error', 'disabled', 'stopped']);

export const ServerTestStateSchema = Schema.Literals(['testing', 'passed', 'failed', 'cancelled']);

export const ServerTestSchema = Schema.Struct({
  name: Schema.String,
  revision: Schema.String,
  state: ServerTestStateSchema,
  message: Schema.String,
});

export const OverviewServerSchema = Schema.Struct({
  name: Schema.String,
  transport: Schema.Literals(['http', 'stdio']),
  target: Schema.String,
  disabled: Schema.Boolean,
  status: ServerRowStatusSchema,
  hasLive: Schema.Boolean,
  liveError: Schema.NullOr(Schema.String),
});

export const OperationalErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});

export const OverviewProps = Schema.Struct({
  locale: LocaleSchema,
  hasConfig: Schema.Boolean,
  dirty: Schema.Boolean,
  running: Schema.Boolean,
  revision: Schema.NullOr(Schema.String),
  listenerAddress: Schema.NullOr(Schema.String),
  configurationLocked: Schema.Boolean,
  hasConfigError: Schema.Boolean,
  configErrorCode: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  operationalError: Schema.NullOr(OperationalErrorSchema),
  keyReminder: Schema.Boolean,
  servers: Schema.Array(OverviewServerSchema),
});

export const OverviewModel = Schema.Struct({
  test: Schema.NullOr(ServerTestSchema),
  copiedServer: Schema.NullOr(Schema.String),
});

export const OverviewMessage = UiSchema.TaggedEnum({
  DismissedError: {},
  DismissedOperationalError: {},
  DismissedKeyReminder: {},
  ClickedReviewKeys: {},
  ClickedAddServer: {},
  ClickedEditServer: { name: Schema.String },
  ClickedBearPreset: {},
  ToggledServer: { name: Schema.String, enabled: Schema.Boolean },
  ClickedDeleteServer: { name: Schema.String },
  ClickedCopyClientConfig: { name: Schema.String },
  CopyClientConfigCompleted: {
    name: Schema.String,
    copied: Schema.Boolean,
    errorKind: Schema.NullOr(Schema.Literals(['rpc', 'bridge'])),
    errorMessage: Schema.NullOr(Schema.String),
  },
  CopiedBadgeExpired: { name: Schema.String },
  ClickedTestServer: { name: Schema.String },
  TestServerCompleted: {
    name: Schema.String,
    revision: Schema.String,
    outcome: TestServerOutcome,
  },
  ClearedOutdatedTest: {},
});

export const OverviewEvent = UiSchema.TaggedEnum({
  DismissedError: {},
  DismissedOperationalError: {},
  DismissedKeyReminder: {},
  RequestedOpenKeyMigration: {},
  RequestedOpenServerEditor: { name: Schema.NullOr(Schema.String) },
  RequestedOpenBearPreset: {},
  RequestedToggleServer: { name: Schema.String, disabled: Schema.Boolean },
  RequestedDeleteServer: { name: Schema.String },
  ReportedError: { message: Schema.String },
});

export class CopyClientConfig extends Command.Service<CopyClientConfig>()(
  'mcp-gateway/overview/CopyClientConfig',
  { args: { name: Schema.String }, success: OverviewMessage, mode: 'switch' },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ name }) =>
        rpc.copyClientConfig({ name }).pipe(
          Effect.map((outcome) =>
            outcome.ok
              ? OverviewMessage.CopyClientConfigCompleted({
                  name,
                  copied: true,
                  errorKind: null,
                  errorMessage: null,
                })
              : OverviewMessage.CopyClientConfigCompleted({
                  name,
                  copied: false,
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

export const ExpireCopiedBadge = Command.make(
  'mcp-gateway/overview/ExpireCopiedBadge',
  { args: { name: Schema.String }, mode: 'switch' },
  ({ name }) =>
    Effect.sleep('1500 millis').pipe(Effect.as(OverviewMessage.CopiedBadgeExpired({ name }))),
);

export class TestServer extends Command.Service<TestServer>()('mcp-gateway/overview/TestServer', {
  args: { name: Schema.String, expectedRevision: Schema.String },
  success: OverviewMessage,
  mode: 'switch',
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ name, expectedRevision }) =>
        rpc.testServer({ name, expectedRevision }).pipe(
          Effect.map((outcome): TestServerOutcomeValue => {
            if (outcome.ok) {
              return TestServerOutcome.Passed({ protocolVersion: outcome.value.protocolVersion });
            }
            if (outcome.error.kind === 'bridge') {
              return TestServerOutcome.Unavailable();
            }
            return outcome.error.code === 'Cancelled'
              ? TestServerOutcome.Cancelled({ message: outcome.error.message })
              : TestServerOutcome.Failed({ message: outcome.error.message });
          }),
          Effect.map((outcome) =>
            OverviewMessage.TestServerCompleted({ name, revision: expectedRevision, outcome }),
          ),
        );
    }),
  );
}

export const OverviewCommandLayers = Layer.mergeAll(CopyClientConfig.layer, TestServer.layer);

const resolveTranslator = (locale: Locale) => translator(locale);

const resolveTestOutcome = (
  locale: Locale,
  name: string,
  revision: string,
  outcome: TestServerOutcomeValue,
): typeof ServerTestSchema.Type => {
  const t = resolveTranslator(locale);
  switch (outcome._tag) {
    case 'Passed':
      return {
        name,
        revision,
        state: 'passed',
        message: t('overview.testPassed', { version: outcome.protocolVersion }),
      };
    case 'Cancelled':
      return {
        name,
        revision,
        state: 'cancelled',
        message: outcome.message,
      };
    case 'Failed':
      return {
        name,
        revision,
        state: 'failed',
        message: outcome.message,
      };
    case 'Unavailable':
      return {
        name,
        revision,
        state: 'failed',
        message: t('overview.testUnavailable'),
      };
  }
};

export const OverviewView = Html.component({
  name: 'OverviewView',
  props: OverviewProps,
  model: OverviewModel,
  message: OverviewMessage,
  events: OverviewEvent,
}).make({
  init: ($) => $.set({ test: null, copiedServer: null }),
  subscriptions: ({ props }) => {
    const statusKey = `${props.running}:${props.servers
      .map((server) => `${server.name}:${server.status}`)
      .join(',')}`;
    return [
      Subscription.make('clear-outdated-test', [statusKey], () =>
        Stream.succeed(OverviewMessage.ClearedOutdatedTest()),
      ),
    ];
  },
  update: {
    DismissedError: ($) => $.emit(OverviewEvent.DismissedError()),
    DismissedOperationalError: ($) => $.emit(OverviewEvent.DismissedOperationalError()),
    DismissedKeyReminder: ($) => $.emit(OverviewEvent.DismissedKeyReminder()),
    ClickedReviewKeys: ($) =>
      $.props.configurationLocked ? $.model : $.emit(OverviewEvent.RequestedOpenKeyMigration()),
    ClickedAddServer: ($) =>
      $.props.configurationLocked || !$.props.hasConfig
        ? $.model
        : $.emit(OverviewEvent.RequestedOpenServerEditor({ name: null })),
    ClickedEditServer: ($, { name }) =>
      $.props.configurationLocked
        ? $.model
        : $.emit(OverviewEvent.RequestedOpenServerEditor({ name })),
    ClickedBearPreset: ($) =>
      $.props.configurationLocked ? $.model : $.emit(OverviewEvent.RequestedOpenBearPreset()),
    ToggledServer: ($, { name, enabled }) =>
      $.props.configurationLocked || $.props.dirty || $.props.hasConfigError
        ? $.model
        : $.emit(OverviewEvent.RequestedToggleServer({ name, disabled: !enabled })),
    ClickedDeleteServer: ($, { name }) =>
      $.props.configurationLocked ? $.model : $.emit(OverviewEvent.RequestedDeleteServer({ name })),
    ClickedCopyClientConfig: ($, { name }) =>
      $.props.dirty ? $.model : $.run(CopyClientConfig.make({ name })),
    CopyClientConfigCompleted: ($, { name, copied, errorKind, errorMessage }) => {
      if (copied) {
        return $.evolve({ copiedServer: name }).run(ExpireCopiedBadge.make({ name }));
      }
      const t = resolveTranslator($.props.locale);
      const message =
        errorKind === 'rpc' && errorMessage !== null ? errorMessage : t('operations.nativeFailed');
      return $.emit(OverviewEvent.ReportedError({ message }));
    },
    CopiedBadgeExpired: ($, { name }) =>
      $.model.copiedServer === name ? $.evolve({ copiedServer: null }) : $.model,
    ClickedTestServer: ($, { name }) => {
      const revision = $.props.revision;
      if (!revision || $.props.configurationLocked || $.model.test?.state === 'testing') {
        return $.model;
      }
      const t = resolveTranslator($.props.locale);
      return $.evolve({
        test: { name, revision, state: 'testing' as const, message: t('overview.testing') },
      }).run(TestServer.make({ name, expectedRevision: revision }));
    },
    TestServerCompleted: ($, { name, revision, outcome }) => {
      const nextTest = resolveTestOutcome($.props.locale, name, revision, outcome);
      return $.evolve({
        test: isTestOutdated(nextTest, $.props.running, $.props.servers) ? null : nextTest,
      });
    },
    ClearedOutdatedTest: ($) =>
      isTestOutdated($.model.test, $.props.running, $.props.servers)
        ? $.evolve({ test: null })
        : $.model,
  },
  view: (h, model) => {
    const t = resolveTranslator(h.props.locale);
    const locked = h.props.configurationLocked;
    const serverCount = h.props.servers.length;
    const testing = model.test?.state === 'testing';
    const testingServerName = testing ? (model.test?.name ?? null) : null;
    const outdated = isTestOutdated(model.test, h.props.running, h.props.servers);

    return h.div.class('grid gap-5').children(
      h.props.error !== null &&
        renderAlert(h, {
          dismissLabel: t('common.dismissError'),
          onDismiss: OverviewMessage.DismissedError(),
          content: h.props.error,
        }),
      h.props.operationalError !== null &&
        renderAlert(h, {
          dismissLabel: t('common.dismissError'),
          onDismiss: OverviewMessage.DismissedOperationalError(),
          content: `${h.props.operationalError.code}: ${h.props.operationalError.message}`,
        }),
      h.props.keyReminder &&
        renderAlert(h, {
          kind: 'warning',
          role: 'status',
          dismissLabel: t('keys.dismiss'),
          onDismiss: OverviewMessage.DismissedKeyReminder(),
          content: [
            `${t('keys.reminder')} `,
            h.button
              .attr('type', 'button')
              .attr('data-slot', 'button')
              .attr('data-variant', 'link')
              .disabled(locked)
              .class(buttonClasses('link', 'xl'))
              .on('click', OverviewMessage.ClickedReviewKeys())
              .children(t('keys.review')),
          ],
        }),
      h.section.attr('aria-labelledby', 'servers-heading').children(
        h.div.class('section-heading').children(
          h.div.class('flex flex-wrap items-center gap-3').children(
            h.h2
              .attr('id', 'servers-heading')
              .class('flex items-center gap-1.5')
              .children(
                t('overview.servers'),
                h.props.hasConfig && h.span.class('count').children(String(serverCount)),
              ),
            h.span
              .class(
                'inline-flex items-center gap-2 rounded-full border border-mac-border bg-mac-group px-2.5 py-1 text-[12px] text-mac-label',
              )
              .children(
                h.span.class('led', h.props.running && 'on'),
                h.span.children(
                  h.props.running ? t('common.gatewayRunning') : t('common.gatewayStopped'),
                ),
                h.props.listenerAddress !== null &&
                  h.span.class('mono text-mac-label-secondary').children(h.props.listenerAddress),
              ),
          ),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'default')
            .attr('data-size', 'xl')
            .disabled(locked || !h.props.hasConfig)
            .class(buttonClasses('default', 'xl'))
            .on('click', OverviewMessage.ClickedAddServer())
            .children(t('overview.addServer')),
        ),
        h.props.hasConfig &&
          serverCount > 0 &&
          h.div.class('server-table panel').children(
            ...h.props.servers.map((server) => {
              const state = SERVER_STATUS[server.status];
              const shown = visibleTestForServer(
                model.test,
                outdated,
                server.name,
                h.props.revision,
              );
              const blockedKey = resolveTestBlockedKey({
                dirty: h.props.dirty,
                hasConfigError: h.props.hasConfigError,
                running: h.props.running,
                status: server.status,
                testingServerName,
                serverName: server.name,
              });
              const testBlocked = blockedKey ? t(blockedKey) : undefined;
              const testReason = locked ? undefined : testBlocked;
              const testReasonId = `test-reason-${server.name}`;
              const clientCopied = model.copiedServer === server.name;

              return h.article
                .key(server.name)
                .class(server.status === 'error' ? 'server-row error' : 'server-row')
                .children(
                  h.div.class('server-row-main').children(
                    h.div.class('server-cell-name').children(
                      h.span.class('led', state.led).attr('title', t(state.label)),
                      h.strong.children(server.name),
                      h.span
                        .class('server-transport-badge')
                        .children(server.transport === 'http' ? 'HTTP' : 'STDIO'),
                      shown !== null &&
                        h.span
                          .attr('role', 'status')
                          .attr('title', shown.message)
                          .class(
                            'inline-flex shrink-0 items-center',
                            shown.state === 'passed'
                              ? 'text-mac-green'
                              : shown.state === 'failed'
                                ? 'text-mac-red-ink'
                                : 'text-mac-label-secondary',
                          )
                          .children(
                            shown.state === 'testing'
                              ? iconLoader(h)
                              : shown.state === 'passed'
                                ? iconCheck(h)
                                : iconX(h),
                            h.span.class('sr-only').children(shown.message),
                          ),
                    ),
                    h.div
                      .class('server-cell-target')
                      .children(
                        h.div
                          .class('server-endpoint-line')
                          .children(h.span.class('mono').children(`/mcp/${server.name}`)),
                        h.p
                          .class('server-detail mono')
                          .attr('title', server.target)
                          .children(server.target),
                      ),
                    h.div.class('server-cell-switch').children(
                      Switch(h, {
                        props: {
                          checked: !server.disabled,
                          disabled: locked || h.props.dirty || h.props.hasConfigError,
                        },
                        onToggle: ({ checked }) =>
                          OverviewMessage.ToggledServer({ name: server.name, enabled: checked }),
                        view: (parts) =>
                          parts
                            .root(
                              h.button
                                .attr('data-slot', 'switch')
                                .attr('data-size', 'sm')
                                .attr(
                                  'aria-label',
                                  server.disabled ? t('overview.start') : t('overview.stop'),
                                )
                                .class(SWITCH_ROOT_CLASSES),
                            )
                            .children(
                              parts.thumb(
                                h.span
                                  .attr('data-slot', 'switch-thumb')
                                  .class(SWITCH_THUMB_CLASSES),
                              ),
                            ),
                      }),
                    ),
                    h.div.class('server-cell-actions').children(
                      h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'ghost')
                        .attr('data-size', 'icon')
                        .attr('aria-label', t('overview.testConnectionFor', { name: server.name }))
                        .attr('aria-describedby', testReason ? testReasonId : undefined)
                        .attr('title', testReason ?? t('overview.testConnection'))
                        .disabled(locked || testBlocked !== undefined || testing)
                        .class(buttonClasses('ghost', 'icon'))
                        .on('click', OverviewMessage.ClickedTestServer({ name: server.name }))
                        .children(iconPlugZap(h)),
                      testReason !== undefined &&
                        h.span.attr('id', testReasonId).class('sr-only').children(testReason),
                      h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'ghost')
                        .attr('data-size', 'icon')
                        .attr('aria-label', t('overview.copyClientConfig'))
                        .attr('title', clientCopied ? 'Copied' : t('overview.copyClientConfig'))
                        .disabled(!server.hasLive || h.props.dirty)
                        .class(buttonClasses('ghost', 'icon'))
                        .on('click', OverviewMessage.ClickedCopyClientConfig({ name: server.name }))
                        .children(clientCopied ? iconCheck(h) : iconCopy(h)),
                      h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'ghost')
                        .attr('data-size', 'icon')
                        .attr('aria-label', t('common.editServer'))
                        .attr('title', t('common.editServer'))
                        .disabled(locked)
                        .class(buttonClasses('ghost', 'icon'))
                        .on('click', OverviewMessage.ClickedEditServer({ name: server.name }))
                        .children(iconPencil(h)),
                      h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'ghost')
                        .attr('data-size', 'icon')
                        .attr('aria-label', t('overview.delete', { name: server.name }))
                        .attr('title', t('overview.delete', { name: server.name }))
                        .disabled(locked)
                        .class(buttonClasses('ghost', 'icon'))
                        .on('click', OverviewMessage.ClickedDeleteServer({ name: server.name }))
                        .children(iconTrash(h)),
                    ),
                  ),
                  server.liveError !== null &&
                    h.div
                      .class('server-row-detail')
                      .children(h.p.class('inline-error').children(server.liveError)),
                );
            }),
          ),
        h.props.hasConfig &&
          serverCount === 0 &&
          h.div
            .class('empty-state panel')
            .children(
              iconServer(h),
              h.h3.children(t('overview.emptyTitle')),
              h.p.children(t('overview.emptyLine1'), h.br, t('overview.emptyLine2')),
              h.button
                .attr('type', 'button')
                .attr('data-slot', 'button')
                .attr('data-variant', 'secondary')
                .attr('data-size', 'xl')
                .disabled(locked)
                .class(buttonClasses('secondary', 'xl'))
                .on('click', OverviewMessage.ClickedBearPreset())
                .children(t('overview.bearPreset')),
              h.small.children(t('overview.bearNote')),
            ),
        !h.props.hasConfig &&
          h.props.configErrorCode !== 'KeySetupFailed' &&
          h.div
            .class('panel empty-state')
            .children(
              iconCode2(h),
              h.h3.children(t('overview.repairTitle')),
              h.p.children(t('overview.repairBody')),
            ),
      ),
    );
  },
});
