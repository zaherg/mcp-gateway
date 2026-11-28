import { Command, Component, UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Switch } from '@effect/ui-kit';
import { Effect, Layer, Schema } from 'effect';

import {
  isTestOutdated,
  resolveTestBlockedKey,
  SERVER_STATUS,
  visibleTestForServer,
} from '@mcp-gateway/mainview/effect-overview/logic';
import {
  OverviewActions,
  TestServerOutcome,
  type TestServerOutcomeValue,
} from '@mcp-gateway/mainview/effect-overview/services';
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
  locale: Schema.String,
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
  CopyClientConfigCompleted: { name: Schema.String, copied: Schema.Boolean },
  CopiedBadgeExpired: { name: Schema.String },
  ClickedTestServer: { name: Schema.String },
  TestServerCompleted: {
    name: Schema.String,
    revision: Schema.String,
    outcome: TestServerOutcome,
  },
  ClearedOutdatedTest: {},
});

export class ClearError extends Command.Service<ClearError>()('mcp-gateway/overview/ClearError', {
  args: {},
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return () => actions.clearError().pipe(Effect.as(Component.noop));
    }),
  );
}

export class DismissOperationalError extends Command.Service<DismissOperationalError>()(
  'mcp-gateway/overview/DismissOperationalError',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return () => actions.dismissOperationalError().pipe(Effect.as(Component.noop));
    }),
  );
}

export class DismissKeyReminder extends Command.Service<DismissKeyReminder>()(
  'mcp-gateway/overview/DismissKeyReminder',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return () => actions.dismissKeyReminder().pipe(Effect.as(Component.noop));
    }),
  );
}

export class OpenKeyMigration extends Command.Service<OpenKeyMigration>()(
  'mcp-gateway/overview/OpenKeyMigration',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return () => actions.openKeyMigration().pipe(Effect.as(Component.noop));
    }),
  );
}

export class OpenServerEditor extends Command.Service<OpenServerEditor>()(
  'mcp-gateway/overview/OpenServerEditor',
  { args: { name: Schema.NullOr(Schema.String) } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return ({ name }) => actions.openServerEditor(name).pipe(Effect.as(Component.noop));
    }),
  );
}

export class OpenBearPreset extends Command.Service<OpenBearPreset>()(
  'mcp-gateway/overview/OpenBearPreset',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return () => actions.openBearPreset().pipe(Effect.as(Component.noop));
    }),
  );
}

export class ToggleServer extends Command.Service<ToggleServer>()(
  'mcp-gateway/overview/ToggleServer',
  { args: { name: Schema.String, disabled: Schema.Boolean } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return ({ name, disabled }) =>
        actions.toggleServer(name, disabled).pipe(Effect.as(Component.noop));
    }),
  );
}

export class DeleteServer extends Command.Service<DeleteServer>()(
  'mcp-gateway/overview/DeleteServer',
  { args: { name: Schema.String } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return ({ name }) => actions.deleteServer(name).pipe(Effect.as(Component.noop));
    }),
  );
}

export class CopyClientConfig extends Command.Service<CopyClientConfig>()(
  'mcp-gateway/overview/CopyClientConfig',
  { args: { name: Schema.String }, success: OverviewMessage, mode: 'switch' },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* OverviewActions;
      return ({ name }) =>
        actions
          .copyClientConfig(name)
          .pipe(
            Effect.map((copied) => OverviewMessage.CopyClientConfigCompleted({ name, copied })),
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
      const actions = yield* OverviewActions;
      return ({ name, expectedRevision }) =>
        actions
          .testServer(name, expectedRevision)
          .pipe(
            Effect.map((outcome) =>
              OverviewMessage.TestServerCompleted({ name, revision: expectedRevision, outcome }),
            ),
          );
    }),
  );
}

export const OverviewCommandLayers = Layer.mergeAll(
  ClearError.layer,
  DismissOperationalError.layer,
  DismissKeyReminder.layer,
  OpenKeyMigration.layer,
  OpenServerEditor.layer,
  OpenBearPreset.layer,
  ToggleServer.layer,
  DeleteServer.layer,
  CopyClientConfig.layer,
  TestServer.layer,
);

const ALERT_BASE =
  "group/alert relative grid w-full gap-0.5 rounded-[10px] px-3 py-2.5 text-left text-mac-body has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-px *:[svg:not([class*='size-'])]:size-4 flex items-center gap-2.5 text-mac-label";
const ALERT_DESTRUCTIVE =
  'bg-mac-red/8 text-mac-red shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-red)_30%,transparent)] *:[svg]:text-current';
const ALERT_WARNING =
  'bg-mac-yellow/12 text-mac-label shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-yellow)_35%,transparent)] *:[svg]:text-mac-orange';

const BUTTON_BASE =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none transition-[background-color,color,opacity] outline-none focus-visible:mac-focus-ring disabled:pointer-events-none data-disabled:pointer-events-none aria-invalid:mac-focus-ring [&_svg]:pointer-events-none [&_svg]:shrink-0';
const BUTTON_DEFAULT =
  'bg-mac-accent text-mac-accent-foreground active:brightness-90 disabled:opacity-45';
const BUTTON_SECONDARY =
  'bg-mac-control text-mac-label active:bg-mac-control-pressed disabled:bg-mac-control-disabled disabled:text-mac-label-tertiary';
const BUTTON_GHOST =
  'text-mac-label hover:bg-mac-fill-tertiary active:bg-mac-control-pressed disabled:text-mac-label-tertiary';
const BUTTON_LINK =
  'h-auto px-0 text-mac-link underline-offset-2 hover:underline disabled:opacity-45';
const BUTTON_XL = "h-9 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4";
const BUTTON_ICON = "size-6 rounded-[6px] [&_svg:not([class*='size-'])]:size-3.5";

const SWITCH_ROOT_CLASSES =
  'peer group/switch inline-flex shrink-0 items-center rounded-full transition-colors outline-none focus-visible:mac-focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-40 data-[size=mini]:h-4 data-[size=mini]:w-9 data-[size=mini]:px-[1.5px] data-[size=sm]:h-5 data-[size=sm]:w-11 data-[size=sm]:px-0.5 data-checked:bg-mac-accent data-unchecked:bg-black/8.5 dark:data-unchecked:bg-white/8.5 group-data-inactive/window:data-checked:bg-black/14 dark:group-data-inactive/window:data-checked:bg-white/13';

const SWITCH_THUMB_CLASSES =
  'pointer-events-none block rounded-full bg-white shadow-[0_3px_36px_rgb(0_0_0/0.05),0_0_0_0.5px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.12)] transition-transform duration-200 dark:shadow-none dark:group-data-inactive/window:bg-[#e2e2e2] group-data-[size=mini]/switch:h-3.25 group-data-[size=mini]/switch:w-5.25 group-data-[size=sm]/switch:h-4 group-data-[size=sm]/switch:w-6.5 data-unchecked:translate-x-0 group-data-[size=mini]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-checked:translate-x-3.5 rtl:group-data-[size=mini]/switch:data-checked:-translate-x-3 rtl:group-data-[size=sm]/switch:data-checked:-translate-x-3.5';

type OverviewHelper = Html.H<typeof OverviewMessage.Type>;

const resolveTranslator = (locale: string) => translator(locale as Locale);

const svgIcon = (h: OverviewHelper, sizeClass: string, paths: ReadonlyArray<string>) =>
  h.svg
    .class(sizeClass)
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(...paths.map((d) => h.path.attr('d', d)));

const closeIcon = (h: OverviewHelper) => svgIcon(h, 'size-3.5', ['M18 6 6 18', 'm6 6 12 12']);

const checkIcon = (h: OverviewHelper) => svgIcon(h, 'size-3.5', ['M20 6 9 17l-5-5']);

const loaderIcon = (h: OverviewHelper) =>
  svgIcon(h, 'size-3.5 motion-safe:animate-spin', ['M21 12a9 9 0 1 1-6.219-8.56']);

const plugZapIcon = (h: OverviewHelper) =>
  svgIcon(h, 'size-3.5', [
    'M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z',
    'm2 22 3-3',
    'M7.5 13.5 10 11',
    'M10.5 16.5 13 14',
    'm18 3-4 4h6l-4 4',
  ]);

const copyIcon = (h: OverviewHelper) =>
  svgIcon(h, 'size-3.5', [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  ]);

const pencilIcon = (h: OverviewHelper) =>
  svgIcon(h, 'size-3.5', [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ]);

const trashIcon = (h: OverviewHelper) =>
  svgIcon(h, 'size-3.5', [
    'M3 6h18',
    'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
    'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ]);

const serverIcon = (h: OverviewHelper) =>
  h.svg
    .class('size-6')
    .attr('width', '24')
    .attr('height', '24')
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(
      h.rect
        .attr('width', '20')
        .attr('height', '8')
        .attr('x', '2')
        .attr('y', '2')
        .attr('rx', '2')
        .attr('ry', '2'),
      h.rect
        .attr('width', '20')
        .attr('height', '8')
        .attr('x', '2')
        .attr('y', '14')
        .attr('rx', '2')
        .attr('ry', '2'),
      h.path.attr('d', 'M6 6h.01'),
      h.path.attr('d', 'M6 18h.01'),
    );

const code2Icon = (h: OverviewHelper) =>
  svgIcon(h, 'size-6', ['m18 16 4-4-4-4', 'm6 8-4 4 4 4', 'm14.5 4-5 16']);

const resolveTestOutcome = (
  locale: string,
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
}).make({
  init: ($) => $.set({ test: null, copiedServer: null }),
  update: {
    DismissedError: ($) => $.run(ClearError.make()),
    DismissedOperationalError: ($) => $.run(DismissOperationalError.make()),
    DismissedKeyReminder: ($) => $.run(DismissKeyReminder.make()),
    ClickedReviewKeys: ($) =>
      $.props.configurationLocked ? $.model : $.run(OpenKeyMigration.make()),
    ClickedAddServer: ($) =>
      $.props.configurationLocked || !$.props.hasConfig
        ? $.model
        : $.run(OpenServerEditor.make({ name: null })),
    ClickedEditServer: ($, { name }) =>
      $.props.configurationLocked ? $.model : $.run(OpenServerEditor.make({ name })),
    ClickedBearPreset: ($) =>
      $.props.configurationLocked ? $.model : $.run(OpenBearPreset.make()),
    ToggledServer: ($, { name, enabled }) =>
      $.props.configurationLocked || $.props.dirty || $.props.hasConfigError
        ? $.model
        : $.run(ToggleServer.make({ name, disabled: !enabled })),
    ClickedDeleteServer: ($, { name }) =>
      $.props.configurationLocked ? $.model : $.run(DeleteServer.make({ name })),
    ClickedCopyClientConfig: ($, { name }) =>
      $.props.dirty ? $.model : $.run(CopyClientConfig.make({ name })),
    CopyClientConfigCompleted: ($, { name, copied }) =>
      copied ? $.evolve({ copiedServer: name }).run(ExpireCopiedBadge.make({ name })) : $.model,
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
    TestServerCompleted: ($, { name, revision, outcome }) =>
      $.evolve({
        test: resolveTestOutcome($.props.locale, name, revision, outcome),
      }),
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

    const renderDestructiveAlert = (text: string, onDismiss: typeof OverviewMessage.Type) =>
      h.div
        .attr('data-slot', 'alert')
        .attr('role', 'alert')
        .class(ALERT_BASE, ALERT_DESTRUCTIVE)
        .children(
          h.span.class('min-w-0 flex-1 wrap-anywhere').children(text),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'ghost')
            .attr('data-size', 'icon')
            .attr('aria-label', t('common.dismissError'))
            .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
            .on('click', onDismiss)
            .children(closeIcon(h)),
        );

    return h.div.class('grid gap-5').children(
      h.props.error !== null &&
        renderDestructiveAlert(h.props.error, OverviewMessage.DismissedError()),
      h.props.operationalError !== null &&
        renderDestructiveAlert(
          `${h.props.operationalError.code}: ${h.props.operationalError.message}`,
          OverviewMessage.DismissedOperationalError(),
        ),
      h.props.keyReminder &&
        h.div
          .attr('data-slot', 'alert')
          .attr('role', 'status')
          .class(ALERT_BASE, ALERT_WARNING)
          .children(
            h.span
              .class('min-w-0 flex-1 wrap-anywhere')
              .children(
                `${t('keys.reminder')} `,
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'link')
                  .disabled(locked)
                  .class(BUTTON_BASE, BUTTON_LINK)
                  .on('click', OverviewMessage.ClickedReviewKeys())
                  .children(t('keys.review')),
              ),
            h.button
              .attr('type', 'button')
              .attr('data-slot', 'button')
              .attr('data-variant', 'ghost')
              .attr('data-size', 'icon')
              .attr('aria-label', t('keys.dismiss'))
              .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
              .on('click', OverviewMessage.DismissedKeyReminder())
              .children(closeIcon(h)),
          ),
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
            .class(BUTTON_BASE, BUTTON_DEFAULT, BUTTON_XL)
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
                              ? loaderIcon(h)
                              : shown.state === 'passed'
                                ? checkIcon(h)
                                : closeIcon(h),
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
                        .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
                        .on('click', OverviewMessage.ClickedTestServer({ name: server.name }))
                        .children(plugZapIcon(h)),
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
                        .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
                        .on('click', OverviewMessage.ClickedCopyClientConfig({ name: server.name }))
                        .children(clientCopied ? checkIcon(h) : copyIcon(h)),
                      h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'ghost')
                        .attr('data-size', 'icon')
                        .attr('aria-label', t('common.editServer'))
                        .attr('title', t('common.editServer'))
                        .disabled(locked)
                        .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
                        .on('click', OverviewMessage.ClickedEditServer({ name: server.name }))
                        .children(pencilIcon(h)),
                      h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'ghost')
                        .attr('data-size', 'icon')
                        .attr('aria-label', t('overview.delete', { name: server.name }))
                        .attr('title', t('overview.delete', { name: server.name }))
                        .disabled(locked)
                        .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
                        .on('click', OverviewMessage.ClickedDeleteServer({ name: server.name }))
                        .children(trashIcon(h)),
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
              serverIcon(h),
              h.h3.children(t('overview.emptyTitle')),
              h.p.children(t('overview.emptyLine1'), h.br, t('overview.emptyLine2')),
              h.button
                .attr('type', 'button')
                .attr('data-slot', 'button')
                .attr('data-variant', 'secondary')
                .attr('data-size', 'xl')
                .disabled(locked)
                .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_XL)
                .on('click', OverviewMessage.ClickedBearPreset())
                .children(t('overview.bearPreset')),
              h.small.children(t('overview.bearNote')),
            ),
        !h.props.hasConfig &&
          h.props.configErrorCode !== 'KeySetupFailed' &&
          h.div
            .class('panel empty-state')
            .children(
              code2Icon(h),
              h.h3.children(t('overview.repairTitle')),
              h.p.children(t('overview.repairBody')),
            ),
      ),
    );
  },
});
