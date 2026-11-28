import { Command, Component, UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Switch } from '@effect/ui-kit';
import { Effect, Layer, Schema } from 'effect';

import {
  computeHostPatch,
  computePeersPatch,
  computePortPatch,
  computeTokenPatch,
  draftsFromSavedConfig,
  formatImportStatus,
} from '@mcp-gateway/mainview/effect-settings/logic';
import { GatewayMutation, SettingsActions } from '@mcp-gateway/mainview/effect-settings/services';
import {
  type Locale,
  languageName,
  localeTag,
  type MessageKey,
  parseLanguagePreference,
  translator,
} from '@mcp-gateway/shared/i18n';
import { parseAppearancePreference } from '@mcp-gateway/shared/rpc';
import type { NetworkKind } from '@mcp-gateway/shared/types';

export const NetworkKindSchema = Schema.Literals(['loopback', 'lan', 'tailscale', 'tunnel']);

export const InterfaceChoiceSchema = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
  kind: NetworkKindSchema,
});

export const LoginStatusSchema = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

export const OperationalErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});

export const SavedGatewayConfigSchema = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  allowedPeers: Schema.NullOr(Schema.Array(Schema.String)),
  token: Schema.NullOr(Schema.String),
  tokenRef: Schema.NullOr(Schema.String),
  launchAtLogin: Schema.Boolean,
  autoStart: Schema.Boolean,
  keepAwake: Schema.Boolean,
});

export const SettingsProps = Schema.Struct({
  locale: Schema.String,
  filename: Schema.String,
  hasSnapshot: Schema.Boolean,
  dirty: Schema.Boolean,
  busy: Schema.Boolean,
  configurationLocked: Schema.Boolean,
  showToken: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  operationalError: Schema.NullOr(OperationalErrorSchema),
  revision: Schema.NullOr(Schema.String),
  appearance: Schema.String,
  languagePreference: Schema.String,
  availableLanguages: Schema.Array(Schema.String),
  login: LoginStatusSchema,
  retryLogin: Schema.Boolean,
  interfaces: Schema.Array(InterfaceChoiceSchema),
  hasMovableKeys: Schema.Boolean,
  savedConfig: Schema.NullOr(SavedGatewayConfigSchema),
});

export const SettingsModel = Schema.Struct({
  hostInput: Schema.String,
  portInput: Schema.String,
  peersText: Schema.String,
  tokenInput: Schema.String,
  importStatus: Schema.NullOr(Schema.String),
});

export const SettingsMessage = UiSchema.TaggedEnum({
  SyncedSavedConfig: {
    hostInput: Schema.String,
    portInput: Schema.String,
    peersText: Schema.String,
    tokenInput: Schema.String,
  },
  DismissedError: {},
  DismissedOperationalError: {},
  ToggledLaunchAtLogin: { checked: Schema.Boolean },
  ClickedRetryLogin: {},
  ToggledAutoStart: { checked: Schema.Boolean },
  ToggledKeepAwake: { checked: Schema.Boolean },
  ChangedAppearance: { value: Schema.String },
  ChangedLanguage: { value: Schema.String },
  ChangedHost: { value: Schema.String },
  CommittedHost: {},
  ChangedPort: { value: Schema.String },
  CommittedPort: {},
  ChangedPeers: { value: Schema.String },
  CommittedPeers: {},
  ChangedToken: { value: Schema.String },
  CommittedToken: {},
  ClickedToggleShowToken: {},
  ClickedGenerateToken: {},
  GeneratedToken: { token: Schema.String },
  ClickedOpenKeyMigration: {},
  ClickedRevealConfig: {},
  ClickedOpenConfigInEditor: {},
  ClickedImportExternalServers: {},
  ImportExternalServersCompleted: { count: Schema.NullOr(Schema.Number) },
});

export class CommitGatewayMutation extends Command.Service<CommitGatewayMutation>()(
  'mcp-gateway/settings/CommitGatewayMutation',
  { args: { mutation: GatewayMutation } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return ({ mutation }) =>
        actions.commitGatewayMutation(mutation).pipe(Effect.as(Component.noop));
    }),
  );
}

export class ClearError extends Command.Service<ClearError>()('mcp-gateway/settings/ClearError', {
  args: {},
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return () => actions.clearError().pipe(Effect.as(Component.noop));
    }),
  );
}

export class DismissOperationalError extends Command.Service<DismissOperationalError>()(
  'mcp-gateway/settings/DismissOperationalError',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return () => actions.dismissOperationalError().pipe(Effect.as(Component.noop));
    }),
  );
}

export class SetShowToken extends Command.Service<SetShowToken>()(
  'mcp-gateway/settings/SetShowToken',
  { args: { show: Schema.Boolean } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return ({ show }) => actions.setShowToken(show).pipe(Effect.as(Component.noop));
    }),
  );
}

export class OpenKeyMigration extends Command.Service<OpenKeyMigration>()(
  'mcp-gateway/settings/OpenKeyMigration',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return () => actions.openKeyMigration().pipe(Effect.as(Component.noop));
    }),
  );
}

export class ChangeAppearance extends Command.Service<ChangeAppearance>()(
  'mcp-gateway/settings/ChangeAppearance',
  { args: { preference: Schema.String } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return ({ preference }) =>
        actions.changeAppearance(preference).pipe(Effect.as(Component.noop));
    }),
  );
}

export class ChangeLanguage extends Command.Service<ChangeLanguage>()(
  'mcp-gateway/settings/ChangeLanguage',
  { args: { preference: Schema.String } },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return ({ preference }) => actions.changeLanguage(preference).pipe(Effect.as(Component.noop));
    }),
  );
}

export class RevealConfig extends Command.Service<RevealConfig>()(
  'mcp-gateway/settings/RevealConfig',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return () => actions.revealConfig().pipe(Effect.as(Component.noop));
    }),
  );
}

export class OpenConfigInEditor extends Command.Service<OpenConfigInEditor>()(
  'mcp-gateway/settings/OpenConfigInEditor',
  { args: {} },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return () => actions.openConfigInEditor().pipe(Effect.as(Component.noop));
    }),
  );
}

export class GenerateAndCommitToken extends Command.Service<GenerateAndCommitToken>()(
  'mcp-gateway/settings/GenerateAndCommitToken',
  { args: {}, success: SettingsMessage },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return () =>
        Effect.gen(function* () {
          const token = yield* actions.generateToken();
          yield* actions.commitGatewayMutation(GatewayMutation.ReplaceTokenWithLiteral({ token }));
          return SettingsMessage.GeneratedToken({ token });
        });
    }),
  );
}

export class ImportExternalServers extends Command.Service<ImportExternalServers>()(
  'mcp-gateway/settings/ImportExternalServers',
  { args: {}, success: SettingsMessage, mode: 'switch' },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const actions = yield* SettingsActions;
      return () =>
        actions
          .importExternalServers()
          .pipe(Effect.map((count) => SettingsMessage.ImportExternalServersCompleted({ count })));
    }),
  );
}

export const SettingsCommandLayers = Layer.mergeAll(
  CommitGatewayMutation.layer,
  ClearError.layer,
  DismissOperationalError.layer,
  SetShowToken.layer,
  OpenKeyMigration.layer,
  ChangeAppearance.layer,
  ChangeLanguage.layer,
  RevealConfig.layer,
  OpenConfigInEditor.layer,
  GenerateAndCommitToken.layer,
  ImportExternalServers.layer,
);

const NETWORK_LABELS: Record<NetworkKind, MessageKey> = {
  loopback: 'settings.networkKind.loopback',
  lan: 'settings.networkKind.lan',
  tailscale: 'settings.networkKind.tailscale',
  tunnel: 'settings.networkKind.tunnel',
};

const ALERT_CLASSES =
  "group/alert relative grid w-full gap-0.5 rounded-[10px] px-3 py-2.5 text-left text-mac-body has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-px *:[svg:not([class*='size-'])]:size-4 bg-mac-red/8 text-mac-red shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-red)_30%,transparent)] *:[svg]:text-current mb-4 flex items-center gap-2.5 text-mac-label";

const BUTTON_BASE =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none transition-[background-color,color,opacity] outline-none focus-visible:mac-focus-ring disabled:pointer-events-none data-disabled:pointer-events-none aria-invalid:mac-focus-ring [&_svg]:pointer-events-none [&_svg]:shrink-0';
const BUTTON_SECONDARY =
  'bg-mac-control text-mac-label active:bg-mac-control-pressed disabled:bg-mac-control-disabled disabled:text-mac-label-tertiary';
const BUTTON_GHOST =
  'text-mac-label hover:bg-mac-fill-tertiary active:bg-mac-control-pressed disabled:text-mac-label-tertiary';
const BUTTON_LG = "h-7 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4";
const BUTTON_XL = "h-9 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4";
const BUTTON_ICON = "size-6 rounded-[6px] [&_svg:not([class*='size-'])]:size-3.5";
const BUTTON_ICON_LG = "size-7 rounded-full [&_svg:not([class*='size-'])]:size-4";

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-[6px] bg-mac-field px-2 text-mac-body font-medium text-mac-label shadow-[0_0_0_1px_var(--mac-field-border)] transition-[box-shadow] outline-none selection:bg-mac-accent/30 file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-mac-body file:font-medium file:text-mac-label placeholder:font-normal placeholder:text-mac-label-tertiary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:shadow-[0_0_0_1px_var(--mac-field-border),0_0_0_3.5px_color-mix(in_srgb,var(--mac-accent)_50%,transparent),inset_0_0_0_1px_color-mix(in_srgb,var(--mac-accent)_50%,transparent)] aria-invalid:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--mac-red)_50%,transparent)]';

const LABEL_CLASSES =
  'flex items-center gap-1.5 text-mac-body leading-none font-normal text-mac-label select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 font-semibold';

const SELECT_CLASSES =
  'h-9 w-full min-w-0 cursor-default appearance-none rounded-lg bg-mac-control py-0 pr-7 pl-3 text-mac-body font-medium text-mac-label outline-none select-none focus-visible:mac-focus-ring active:bg-mac-control-pressed disabled:pointer-events-none aria-invalid:mac-focus-ring data-[size=md]:h-7 data-[size=md]:rounded-mac-control data-[size=sm]:h-5 data-[size=sm]:rounded-[5px] data-[size=sm]:pl-2.5 data-[size=sm]:text-mac-subheadline';

const SWITCH_ROOT_CLASSES =
  'peer group/switch inline-flex shrink-0 items-center rounded-full transition-colors outline-none focus-visible:mac-focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-40 data-[size=mini]:h-4 data-[size=mini]:w-9 data-[size=mini]:px-[1.5px] data-[size=sm]:h-5 data-[size=sm]:w-11 data-[size=sm]:px-0.5 data-checked:bg-mac-accent data-unchecked:bg-black/8.5 dark:data-unchecked:bg-white/8.5 group-data-inactive/window:data-checked:bg-black/14 dark:group-data-inactive/window:data-checked:bg-white/13';

const SWITCH_THUMB_CLASSES =
  'pointer-events-none block rounded-full bg-white shadow-[0_3px_36px_rgb(0_0_0/0.05),0_0_0_0.5px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.12)] transition-transform duration-200 dark:shadow-none dark:group-data-inactive/window:bg-[#e2e2e2] group-data-[size=mini]/switch:h-3.25 group-data-[size=mini]/switch:w-5.25 group-data-[size=sm]/switch:h-4 group-data-[size=sm]/switch:w-6.5 data-unchecked:translate-x-0 group-data-[size=mini]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-checked:translate-x-3.5 rtl:group-data-[size=mini]/switch:data-checked:-translate-x-3 rtl:group-data-[size=sm]/switch:data-checked:-translate-x-3.5';

type SettingsHelper = Html.H<typeof SettingsMessage.Type>;

const resolveTranslator = (locale: string) => translator(locale as Locale);

const closeIcon = (h: SettingsHelper) =>
  h.svg
    .class('size-3.5')
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(h.path.attr('d', 'M18 6 6 18'), h.path.attr('d', 'm6 6 12 12'));

const chevronsUpDownIcon = (h: SettingsHelper) =>
  h.svg
    .class(
      'pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-mac-label group-data-[size=sm]/native-select:size-2.5',
    )
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2.5')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .attr('data-slot', 'native-select-icon')
    .children(h.path.attr('d', 'm7 15 5 5 5-5'), h.path.attr('d', 'm7 9 5-5 5 5'));

const eyeIcon = (h: SettingsHelper) =>
  h.svg
    .class('size-4')
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(
      h.path.attr(
        'd',
        'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
      ),
      h.circle.attr('cx', '12').attr('cy', '12').attr('r', '3'),
    );

const eyeOffIcon = (h: SettingsHelper) =>
  h.svg
    .class('size-4')
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(
      h.path.attr(
        'd',
        'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49',
      ),
      h.path.attr('d', 'M14.084 14.158a3 3 0 0 1-4.242-4.242'),
      h.path.attr(
        'd',
        'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143',
      ),
      h.path.attr('d', 'm2 2 20 20'),
    );

const renderToggleRow = (
  h: SettingsHelper,
  options: {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly onToggle: (checked: boolean) => typeof SettingsMessage.Type;
  },
) =>
  Switch(h, {
    props: { checked: options.checked, disabled: options.disabled },
    onToggle: ({ checked }) => options.onToggle(checked),
    view: (parts) =>
      h.label
        .class('toggle-row')
        .attr('for', options.id)
        .children(
          h.span.children(h.strong.children(options.label), h.small.children(options.description)),
          parts
            .root(
              h.button
                .attr('id', options.id)
                .attr('data-slot', 'switch')
                .attr('data-size', 'sm')
                .class(SWITCH_ROOT_CLASSES),
            )
            .children(
              parts.thumb(h.span.attr('data-slot', 'switch-thumb').class(SWITCH_THUMB_CLASSES)),
            ),
        ),
  });

export const SettingsView = Html.component({
  name: 'SettingsView',
  props: SettingsProps,
  model: SettingsModel,
  message: SettingsMessage,
}).make({
  init: ($) =>
    $.set({
      ...draftsFromSavedConfig($.props.savedConfig),
      importStatus: null,
    }),
  update: {
    SyncedSavedConfig: ($, { hostInput, portInput, peersText, tokenInput }) =>
      $.evolve({ hostInput, portInput, peersText, tokenInput }),
    DismissedError: ($) => $.run(ClearError.make()),
    DismissedOperationalError: ($) => $.run(DismissOperationalError.make()),
    ToggledLaunchAtLogin: ($, { checked }) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetLaunchAtLogin({ value: checked }),
            }),
          ),
    ClickedRetryLogin: ($) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetLaunchAtLogin({
                value: $.props.savedConfig.launchAtLogin,
              }),
            }),
          ),
    ToggledAutoStart: ($, { checked }) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetAutoStart({ value: checked }),
            }),
          ),
    ToggledKeepAwake: ($, { checked }) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetKeepAwake({ value: checked }),
            }),
          ),
    ChangedAppearance: ($, { value }) => {
      const preference = parseAppearancePreference(value);
      return preference ? $.run(ChangeAppearance.make({ preference })) : $.model;
    },
    ChangedLanguage: ($, { value }) => {
      const preference = parseLanguagePreference(value, $.props.availableLanguages as Locale[]);
      return preference ? $.run(ChangeLanguage.make({ preference })) : $.model;
    },
    ChangedHost: ($, { value }) => $.evolve({ hostInput: value }),
    CommittedHost: ($) => {
      const nextHost = computeHostPatch(
        $.model.hostInput,
        $.props.savedConfig,
        $.props.configurationLocked,
      );
      return nextHost === null
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetHost({ host: nextHost }),
            }),
          );
    },
    ChangedPort: ($, { value }) => $.evolve({ portInput: value }),
    CommittedPort: ($) => {
      const nextPort = computePortPatch(
        $.model.portInput,
        $.props.savedConfig,
        $.props.configurationLocked,
      );
      return nextPort === null
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetPort({ port: nextPort }),
            }),
          );
    },
    ChangedPeers: ($, { value }) => $.evolve({ peersText: value }),
    CommittedPeers: ($) => {
      const nextPeers = computePeersPatch(
        $.model.peersText,
        $.props.savedConfig,
        $.props.configurationLocked,
      );
      return nextPeers === null
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetAllowedPeers({ allowedPeers: nextPeers.allowedPeers }),
            }),
          );
    },
    ChangedToken: ($, { value }) => $.evolve({ tokenInput: value }),
    CommittedToken: ($) => {
      const nextToken = computeTokenPatch(
        $.model.tokenInput,
        $.props.savedConfig,
        $.props.configurationLocked,
      );
      return nextToken === null
        ? $.model
        : $.run(
            CommitGatewayMutation.make({
              mutation: GatewayMutation.SetToken({ token: nextToken }),
            }),
          );
    },
    ClickedToggleShowToken: ($) => $.run(SetShowToken.make({ show: !$.props.showToken })),
    ClickedGenerateToken: ($) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.run(GenerateAndCommitToken.make()),
    GeneratedToken: ($, { token }) => $.evolve({ tokenInput: token }),
    ClickedOpenKeyMigration: ($) =>
      $.props.configurationLocked ? $.model : $.run(OpenKeyMigration.make()),
    ClickedRevealConfig: ($) =>
      $.props.configurationLocked || $.props.busy ? $.model : $.run(RevealConfig.make()),
    ClickedOpenConfigInEditor: ($) =>
      $.props.configurationLocked || $.props.busy ? $.model : $.run(OpenConfigInEditor.make()),
    ClickedImportExternalServers: ($) =>
      $.props.configurationLocked || $.props.busy || $.props.dirty
        ? $.model
        : $.run(ImportExternalServers.make()),
    ImportExternalServersCompleted: ($, { count }) =>
      count === null ? $.model : $.evolve({ importStatus: formatImportStatus(count) }),
  },
  view: (h, model) => {
    if (!h.props.hasSnapshot) return h.text('');

    const t = resolveTranslator(h.props.locale);
    const saved = h.props.savedConfig;
    const locked = h.props.configurationLocked;
    const busy = h.props.busy;
    const dirty = h.props.dirty;
    const importing = h.isRunning(ImportExternalServers);

    const renderAlert = (text: string, onDismiss: typeof SettingsMessage.Type) =>
      h.div
        .attr('data-slot', 'alert')
        .attr('role', 'alert')
        .class(ALERT_CLASSES)
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

    return h.section.class('panel settings-panel').children(
      h.props.error !== null && renderAlert(h.props.error, SettingsMessage.DismissedError()),
      h.props.operationalError !== null &&
        renderAlert(
          `${h.props.operationalError.code}: ${h.props.operationalError.message}`,
          SettingsMessage.DismissedOperationalError(),
        ),
      h.div
        .class('section-heading')
        .children(
          h.div.children(
            h.h2.children(t('settings.preferences')),
            h.p.children(t('settings.preferencesIntro', { filename: h.props.filename })),
          ),
        ),
      saved !== null
        ? h.div.class('grid gap-4').children(
            h.div.class('settings-group').children(
              h.h3.children('General'),
              renderToggleRow(h, {
                id: 'settings-switch-launch-at-login',
                label: t('settings.launchAtLogin'),
                description: t('settings.launchAtLoginDescription'),
                checked: saved.launchAtLogin,
                disabled: locked,
                onToggle: (checked) => SettingsMessage.ToggledLaunchAtLogin({ checked }),
              }),
              h.div
                .class('login-status')
                .children(
                  h.div
                    .class('min-w-0 flex-1')
                    .children(
                      h.p
                        .class('login-state')
                        .children(
                          h.span.class(
                            'led',
                            h.props.login.supported && h.props.login.enabled && 'on',
                          ),
                          !h.props.login.supported
                            ? t('settings.loginItemUnsupported')
                            : h.props.login.enabled
                              ? t('settings.loginItemEnabled')
                              : t('settings.loginItemDisabled'),
                        ),
                      h.props.login.error !== null &&
                        h.p.class('inline-error').children(h.props.login.error),
                      h.small.children(t('settings.loginItemNote')),
                    ),
                  h.props.retryLogin &&
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'secondary')
                      .attr('data-size', 'lg')
                      .disabled(locked)
                      .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_LG)
                      .on('click', SettingsMessage.ClickedRetryLogin())
                      .children(t('draft.retryLogin')),
                ),
              renderToggleRow(h, {
                id: 'settings-switch-auto-start',
                label: t('settings.autoStart'),
                description: t('settings.autoStartDescription'),
                checked: saved.autoStart,
                disabled: locked,
                onToggle: (checked) => SettingsMessage.ToggledAutoStart({ checked }),
              }),
              renderToggleRow(h, {
                id: 'settings-switch-keep-awake',
                label: t('settings.keepAwake'),
                description: t('settings.keepAwakeDescription'),
                checked: saved.keepAwake,
                disabled: locked,
                onToggle: (checked) => SettingsMessage.ToggledKeepAwake({ checked }),
              }),
              h.div.class('field-row').children(
                h.div
                  .class('field-row-copy')
                  .children(
                    h.label
                      .attr('data-slot', 'label')
                      .attr('for', 'settings-appearance')
                      .attr('id', 'settings-appearance-label')
                      .class(LABEL_CLASSES)
                      .children(t('shell.appearanceLabel')),
                    h.small
                      .attr('id', 'settings-appearance-help')
                      .children(t('shell.appearanceHelp')),
                  ),
                h.div
                  .class(
                    'group/native-select relative w-fit max-w-56 shrink-0 has-[select:disabled]:opacity-50',
                  )
                  .attr('data-slot', 'native-select-wrapper')
                  .attr('data-size', 'md')
                  .children(
                    h.select
                      .attr('id', 'settings-appearance')
                      .attr('aria-describedby', 'settings-appearance-help')
                      .attr('data-slot', 'native-select')
                      .attr('data-size', 'md')
                      .class(SELECT_CLASSES)
                      .disabled(locked || busy)
                      .value(h.props.appearance)
                      .on('change', ({ value }) => SettingsMessage.ChangedAppearance({ value }))
                      .children(
                        h.option
                          .attr('data-slot', 'native-select-option')
                          .attr('value', 'system')
                          .class('bg-[Canvas] text-[CanvasText]')
                          .children(t('shell.appearanceSystem')),
                        h.option
                          .attr('data-slot', 'native-select-option')
                          .attr('value', 'light')
                          .class('bg-[Canvas] text-[CanvasText]')
                          .children(t('shell.appearanceLight')),
                        h.option
                          .attr('data-slot', 'native-select-option')
                          .attr('value', 'dark')
                          .class('bg-[Canvas] text-[CanvasText]')
                          .children(t('shell.appearanceDark')),
                      ),
                    chevronsUpDownIcon(h),
                  ),
              ),
              h.div.class('field-row').children(
                h.div
                  .class('field-row-copy')
                  .children(
                    h.label
                      .attr('data-slot', 'label')
                      .attr('for', 'settings-language')
                      .attr('id', 'settings-language-label')
                      .class(LABEL_CLASSES)
                      .children(t('shell.languageLabel')),
                    h.small.attr('id', 'settings-language-help').children(t('shell.languageHelp')),
                  ),
                h.div
                  .class(
                    'group/native-select relative w-fit max-w-56 shrink-0 has-[select:disabled]:opacity-50',
                  )
                  .attr('data-slot', 'native-select-wrapper')
                  .attr('data-size', 'md')
                  .children(
                    h.select
                      .attr('id', 'settings-language')
                      .attr('aria-describedby', 'settings-language-help')
                      .attr('data-slot', 'native-select')
                      .attr('data-size', 'md')
                      .class(SELECT_CLASSES)
                      .disabled(locked || busy)
                      .value(h.props.languagePreference)
                      .on('change', ({ value }) => SettingsMessage.ChangedLanguage({ value }))
                      .children(
                        h.option
                          .attr('data-slot', 'native-select-option')
                          .attr('value', 'system')
                          .class('bg-[Canvas] text-[CanvasText]')
                          .children(t('shell.languageSystem')),
                        ...h.props.availableLanguages.map((locale) =>
                          h.option
                            .key(locale)
                            .attr('data-slot', 'native-select-option')
                            .attr('value', locale)
                            .attr('lang', localeTag(locale as Locale))
                            .class('bg-[Canvas] text-[CanvasText]')
                            .children(languageName(locale as Locale)),
                        ),
                      ),
                    chevronsUpDownIcon(h),
                  ),
              ),
            ),
            h.div.class('settings-group').children(
              h.h3.children('Network'),
              h.div.class('form-grid').children(
                h.div.class('field').children(
                  h.label
                    .attr('data-slot', 'label')
                    .attr('for', 'settings-address')
                    .attr('id', 'settings-address-label')
                    .class(LABEL_CLASSES)
                    .children(t('settings.address')),
                  h.input
                    .attr('id', 'settings-address')
                    .attr('data-slot', 'input')
                    .attr('aria-label', t('settings.address'))
                    .attr('aria-describedby', 'settings-address-help')
                    .attr('list', 'interfaces')
                    .attr('readonly', locked ? '' : undefined)
                    .class(INPUT_CLASSES)
                    .value(model.hostInput)
                    .on('input', ({ value }) => SettingsMessage.ChangedHost({ value }))
                    .on('change', ({ value }) => SettingsMessage.ChangedHost({ value }))
                    .on('blur', SettingsMessage.CommittedHost())
                    .on(
                      'keydown',
                      (event) =>
                        event.key === 'Enter' ? SettingsMessage.CommittedHost() : undefined,
                      { preventDefault: true },
                    ),
                  h.datalist.attr('id', 'interfaces').children(
                    ...h.props.interfaces.map((item) =>
                      h.option
                        .key(`${item.name}-${item.address}`)
                        .attr('value', item.address)
                        .children(`${item.name} · ${t(NETWORK_LABELS[item.kind])}`),
                    ),
                  ),
                  h.small.attr('id', 'settings-address-help').children(t('settings.addressHelp')),
                ),
                h.div.class('field').children(
                  h.label
                    .attr('data-slot', 'label')
                    .attr('for', 'settings-port')
                    .attr('id', 'settings-port-label')
                    .class(LABEL_CLASSES)
                    .children(t('settings.port')),
                  h.input
                    .attr('id', 'settings-port')
                    .attr('data-slot', 'input')
                    .attr('type', 'number')
                    .attr('min', '1')
                    .attr('max', '65535')
                    .attr('readonly', locked ? '' : undefined)
                    .class(INPUT_CLASSES)
                    .value(model.portInput)
                    .on('input', ({ value }) => SettingsMessage.ChangedPort({ value }))
                    .on('change', ({ value }) => SettingsMessage.ChangedPort({ value }))
                    .on('blur', SettingsMessage.CommittedPort())
                    .on(
                      'keydown',
                      (event) =>
                        event.key === 'Enter' ? SettingsMessage.CommittedPort() : undefined,
                      { preventDefault: true },
                    ),
                ),
              ),
              h.div.class('field').children(
                h.label
                  .attr('data-slot', 'label')
                  .attr('for', 'settings-peers')
                  .attr('id', 'settings-peers-label')
                  .class(LABEL_CLASSES)
                  .children(t('settings.peers')),
                h.input
                  .attr('id', 'settings-peers')
                  .attr('data-slot', 'input')
                  .attr('autocomplete', 'off')
                  .attr('spellcheck', 'false')
                  .attr('placeholder', t('settings.peersPlaceholder'))
                  .attr('aria-describedby', 'settings-peers-help')
                  .attr('readonly', locked ? '' : undefined)
                  .class(INPUT_CLASSES)
                  .value(model.peersText)
                  .on('input', ({ value }) => SettingsMessage.ChangedPeers({ value }))
                  .on('change', ({ value }) => SettingsMessage.ChangedPeers({ value }))
                  .on('blur', SettingsMessage.CommittedPeers())
                  .on(
                    'keydown',
                    (event) =>
                      event.key === 'Enter' ? SettingsMessage.CommittedPeers() : undefined,
                    { preventDefault: true },
                  ),
                h.small.attr('id', 'settings-peers-help').children(t('settings.peersHelp')),
              ),
            ),
            h.div.class('settings-group').children(
              h.h3.children('Security'),
              h.div.class('field').children(
                h.label
                  .attr('data-slot', 'label')
                  .attr('for', 'settings-token')
                  .attr('id', 'settings-token-label')
                  .class(LABEL_CLASSES)
                  .children(t('settings.token')),
                saved.tokenRef !== null
                  ? h.p.class('m-0 text-[13px]').children(t('keys.stored'))
                  : h.div.class('token-input').children(
                      h.input
                        .attr('id', 'settings-token')
                        .attr('data-slot', 'input')
                        .attr('autocomplete', 'off')
                        .attr('spellcheck', 'false')
                        .attr('type', h.props.showToken ? 'text' : 'password')
                        .attr('aria-describedby', 'settings-token-help')
                        .attr('readonly', locked ? '' : undefined)
                        .class(INPUT_CLASSES)
                        .value(model.tokenInput)
                        .on('input', ({ value }) => SettingsMessage.ChangedToken({ value }))
                        .on('change', ({ value }) => SettingsMessage.ChangedToken({ value }))
                        .on('blur', SettingsMessage.CommittedToken())
                        .on(
                          'keydown',
                          (event) =>
                            event.key === 'Enter' ? SettingsMessage.CommittedToken() : undefined,
                          { preventDefault: true },
                        ),
                      h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'ghost')
                        .attr('data-size', 'icon-lg')
                        .attr(
                          'aria-label',
                          h.props.showToken ? t('settings.hideToken') : t('settings.showToken'),
                        )
                        .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON_LG)
                        .on('click', SettingsMessage.ClickedToggleShowToken())
                        .children(h.props.showToken ? eyeOffIcon(h) : eyeIcon(h)),
                    ),
                h.small.attr('id', 'settings-token-help').children(t('settings.tokenHelp')),
              ),
              h.div
                .class('flex flex-wrap gap-2')
                .children(
                  h.button
                    .attr('type', 'button')
                    .attr('data-slot', 'button')
                    .attr('data-variant', 'secondary')
                    .attr('data-size', 'lg')
                    .disabled(locked)
                    .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_LG)
                    .on('click', SettingsMessage.ClickedGenerateToken())
                    .children(t('settings.generateToken')),
                  h.props.hasMovableKeys &&
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'secondary')
                      .attr('data-size', 'lg')
                      .disabled(locked)
                      .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_LG)
                      .on('click', SettingsMessage.ClickedOpenKeyMigration())
                      .children(t('keys.title')),
                ),
            ),
            h.div.class('settings-group').children(
              h.h3.children('Advanced'),
              h.div.class('flex flex-wrap items-center gap-2').children(
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .disabled(locked || busy)
                  .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_XL)
                  .on('click', SettingsMessage.ClickedRevealConfig())
                  .children(t('raw.showInFinder')),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .disabled(locked || busy)
                  .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_XL)
                  .on('click', SettingsMessage.ClickedOpenConfigInEditor())
                  .children('Open in External Editor'),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .disabled(locked || busy || dirty || importing)
                  .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_XL)
                  .on('click', SettingsMessage.ClickedImportExternalServers())
                  .children('Import Servers from Claude Desktop / Cursor'),
              ),
              model.importStatus !== null &&
                h.p
                  .attr('role', 'status')
                  .class('m-0 mt-2 text-[12px] text-mac-label-secondary')
                  .children(model.importStatus),
            ),
          )
        : h.p.children(t('settings.paused')),
    );
  },
});
