import { Command, Subscription, UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Effect, Redacted, Schema, Stream } from 'effect';

import { ImportOutcomeSchema } from '@mcp-gateway/mainview/effect-app/schemas';
import {
  computeHostPatch,
  computePeersPatch,
  computePortPatch,
  computeTokenPatch,
  draftsFromSavedConfig,
  formatImportStatus,
  type SavedGatewaySnapshot,
} from '@mcp-gateway/mainview/effect-settings/logic';
import { GatewayMutation } from '@mcp-gateway/mainview/effect-settings/services';
import {
  buttonClasses,
  INPUT_CLASSES,
  iconEye,
  iconEyeOff,
  LABEL_CLASSES,
  LocaleSchema,
  renderAlert,
  renderField,
  renderNativeSelect,
  renderToggleRow,
  SELECT_OPTION_CLASSES,
} from '@mcp-gateway/mainview/effect-ui';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
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
  token: Schema.NullOr(Schema.Redacted(Schema.String)),
  tokenRef: Schema.NullOr(Schema.String),
  launchAtLogin: Schema.Boolean,
  autoStart: Schema.Boolean,
  keepAwake: Schema.Boolean,
});

export const SettingsProps = Schema.Struct({
  locale: LocaleSchema,
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
  availableLanguages: Schema.Array(LocaleSchema),
  login: LoginStatusSchema,
  retryLogin: Schema.Boolean,
  interfaces: Schema.Array(InterfaceChoiceSchema),
  hasMovableKeys: Schema.Boolean,
  savedConfig: Schema.NullOr(SavedGatewayConfigSchema),
  lastImport: Schema.NullOr(ImportOutcomeSchema),
});

export const SettingsModel = Schema.Struct({
  hostInput: Schema.String,
  portInput: Schema.String,
  peersText: Schema.String,
  tokenInput: Schema.Redacted(Schema.String),
  initialImportSeq: Schema.NullOr(Schema.Number),
});

export const SettingsMessage = UiSchema.TaggedEnum({
  SyncedSavedConfig: {},
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
  ChangedToken: { value: Schema.Redacted(Schema.String) },
  CommittedToken: {},
  ClickedToggleShowToken: {},
  ClickedGenerateToken: {},
  GeneratedToken: { token: Schema.Redacted(Schema.String) },
  ClickedOpenKeyMigration: {},
  ClickedRevealConfig: {},
  ClickedOpenConfigInEditor: {},
  ClickedImportExternalServers: {},
});

export const GenerateSettingsToken = Command.make(
  'mcp-gateway/settings/GenerateSettingsToken',
  {},
  () =>
    Effect.sync(() => SettingsMessage.GeneratedToken({ token: Redacted.make(generateToken()) })),
);

export const SettingsEvent = UiSchema.TaggedEnum({
  DismissedError: {},
  DismissedOperationalError: {},
  CommittedGatewayMutation: { mutation: GatewayMutation },
  ToggledShowToken: { show: Schema.Boolean },
  RequestedOpenKeyMigration: {},
  ChangedAppearance: { preference: Schema.String },
  ChangedLanguage: { preference: Schema.String },
  RequestedRevealConfig: {},
  RequestedOpenConfigInEditor: {},
  RequestedImportExternalServers: {},
});

const NETWORK_LABELS: Record<NetworkKind, MessageKey> = {
  loopback: 'settings.networkKind.loopback',
  lan: 'settings.networkKind.lan',
  tailscale: 'settings.networkKind.tailscale',
  tunnel: 'settings.networkKind.tunnel',
};

const resolveTranslator = (locale: Locale) => translator(locale);

const toPlainSavedConfig = (
  saved: typeof SavedGatewayConfigSchema.Type | null,
): SavedGatewaySnapshot | null =>
  saved === null
    ? null
    : {
        ...saved,
        token: saved.token === null ? null : Redacted.value(saved.token),
      };

export const SettingsView = Html.component({
  name: 'SettingsView',
  props: SettingsProps,
  model: SettingsModel,
  message: SettingsMessage,
  events: SettingsEvent,
}).make({
  init: ($) => {
    const drafts = draftsFromSavedConfig(toPlainSavedConfig($.props.savedConfig));
    return $.set({
      hostInput: drafts.hostInput,
      portInput: drafts.portInput,
      peersText: drafts.peersText,
      tokenInput: Redacted.make(drafts.tokenInput),
      initialImportSeq: $.props.lastImport?.seq ?? null,
    });
  },
  subscriptions: ({ props }) => {
    // Non-secret key only; never include plaintext token in subscription deps.
    const saved = props.savedConfig;
    const syncKey = saved
      ? [
          props.revision ?? '',
          saved.host,
          String(saved.port),
          (saved.allowedPeers ?? []).join(','),
          saved.tokenRef ?? '',
          saved.token !== null ? '1' : '0',
        ].join('|')
      : 'none';
    return [
      Subscription.make('sync-saved-config', [syncKey], () =>
        Stream.succeed(SettingsMessage.SyncedSavedConfig()),
      ),
    ];
  },
  update: {
    SyncedSavedConfig: ($) => {
      const drafts = draftsFromSavedConfig(toPlainSavedConfig($.props.savedConfig));
      return $.evolve({
        hostInput: drafts.hostInput,
        portInput: drafts.portInput,
        peersText: drafts.peersText,
        tokenInput: Redacted.make(drafts.tokenInput),
      });
    },
    DismissedError: ($) => $.emit(SettingsEvent.DismissedError()),
    DismissedOperationalError: ($) => $.emit(SettingsEvent.DismissedOperationalError()),
    ToggledLaunchAtLogin: ($, { checked }) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetLaunchAtLogin({ value: checked }),
            }),
          ),
    ClickedRetryLogin: ($) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetLaunchAtLogin({
                value: $.props.savedConfig.launchAtLogin,
              }),
            }),
          ),
    ToggledAutoStart: ($, { checked }) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetAutoStart({ value: checked }),
            }),
          ),
    ToggledKeepAwake: ($, { checked }) =>
      !$.props.savedConfig || $.props.configurationLocked
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetKeepAwake({ value: checked }),
            }),
          ),
    ChangedAppearance: ($, { value }) => {
      const preference = parseAppearancePreference(value);
      return preference ? $.emit(SettingsEvent.ChangedAppearance({ preference })) : $.model;
    },
    ChangedLanguage: ($, { value }) => {
      const preference = parseLanguagePreference(value, $.props.availableLanguages);
      return preference ? $.emit(SettingsEvent.ChangedLanguage({ preference })) : $.model;
    },
    ChangedHost: ($, { value }) => $.evolve({ hostInput: value }),
    CommittedHost: ($) => {
      const nextHost = computeHostPatch(
        $.model.hostInput,
        toPlainSavedConfig($.props.savedConfig),
        $.props.configurationLocked,
      );
      return nextHost === null
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetHost({ host: nextHost }),
            }),
          );
    },
    ChangedPort: ($, { value }) => $.evolve({ portInput: value }),
    CommittedPort: ($) => {
      const nextPort = computePortPatch(
        $.model.portInput,
        toPlainSavedConfig($.props.savedConfig),
        $.props.configurationLocked,
      );
      return nextPort === null
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetPort({ port: nextPort }),
            }),
          );
    },
    ChangedPeers: ($, { value }) => $.evolve({ peersText: value }),
    CommittedPeers: ($) => {
      const nextPeers = computePeersPatch(
        $.model.peersText,
        toPlainSavedConfig($.props.savedConfig),
        $.props.configurationLocked,
      );
      return nextPeers === null
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetAllowedPeers({ allowedPeers: nextPeers.allowedPeers }),
            }),
          );
    },
    ChangedToken: ($, { value }) => $.evolve({ tokenInput: value }),
    CommittedToken: ($) => {
      const nextToken = computeTokenPatch(
        Redacted.value($.model.tokenInput),
        toPlainSavedConfig($.props.savedConfig),
        $.props.configurationLocked,
      );
      return nextToken === null
        ? $.model
        : $.emit(
            SettingsEvent.CommittedGatewayMutation({
              mutation: GatewayMutation.SetToken({ token: Redacted.make(nextToken) }),
            }),
          );
    },
    ClickedToggleShowToken: ($) =>
      $.emit(SettingsEvent.ToggledShowToken({ show: !$.props.showToken })),
    ClickedGenerateToken: ($) => {
      if (!$.props.savedConfig || $.props.configurationLocked) return $.model;
      return $.run(GenerateSettingsToken.make());
    },
    GeneratedToken: ($, { token }) => {
      if (!$.props.savedConfig || $.props.configurationLocked) return $.model;
      return $.evolve({ tokenInput: token }).emit(
        SettingsEvent.CommittedGatewayMutation({
          mutation: GatewayMutation.ReplaceTokenWithLiteral({ token }),
        }),
      );
    },
    ClickedOpenKeyMigration: ($) =>
      $.props.configurationLocked ? $.model : $.emit(SettingsEvent.RequestedOpenKeyMigration()),
    ClickedRevealConfig: ($) =>
      $.props.configurationLocked || $.props.busy
        ? $.model
        : $.emit(SettingsEvent.RequestedRevealConfig()),
    ClickedOpenConfigInEditor: ($) =>
      $.props.configurationLocked || $.props.busy
        ? $.model
        : $.emit(SettingsEvent.RequestedOpenConfigInEditor()),
    ClickedImportExternalServers: ($) =>
      $.props.configurationLocked || $.props.busy || $.props.dirty
        ? $.model
        : $.emit(SettingsEvent.RequestedImportExternalServers()),
  },
  view: (h, model) => {
    if (!h.props.hasSnapshot) return h.text('');

    const t = resolveTranslator(h.props.locale);
    const saved = h.props.savedConfig;
    const locked = h.props.configurationLocked;
    const busy = h.props.busy;
    const dirty = h.props.dirty;
    const importStatus =
      h.props.lastImport !== null && h.props.lastImport.seq !== model.initialImportSeq
        ? formatImportStatus(h.props.lastImport.count)
        : null;

    return h.section.class('panel settings-panel').children(
      h.props.error !== null &&
        renderAlert(h, {
          dismissLabel: t('common.dismissError'),
          onDismiss: SettingsMessage.DismissedError(),
          content: h.props.error,
        }),
      h.props.operationalError !== null &&
        renderAlert(h, {
          dismissLabel: t('common.dismissError'),
          onDismiss: SettingsMessage.DismissedOperationalError(),
          content: `${h.props.operationalError.code}: ${h.props.operationalError.message}`,
        }),
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
                      .class(buttonClasses('secondary', 'lg'))
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
              renderField(h, {
                id: 'settings-appearance',
                label: t('shell.appearanceLabel'),
                help: t('shell.appearanceHelp'),
                layout: 'row',
                control: renderNativeSelect(h, {
                  id: 'settings-appearance',
                  value: h.props.appearance,
                  disabled: locked || busy,
                  ariaDescribedBy: 'settings-appearance-help',
                  size: 'md',
                  width: 'fit',
                  wrapperClass: 'max-w-56 shrink-0',
                  onChange: (value) => SettingsMessage.ChangedAppearance({ value }),
                  options: [
                    h.option
                      .attr('data-slot', 'native-select-option')
                      .attr('value', 'system')
                      .class(SELECT_OPTION_CLASSES)
                      .children(t('shell.appearanceSystem')),
                    h.option
                      .attr('data-slot', 'native-select-option')
                      .attr('value', 'light')
                      .class(SELECT_OPTION_CLASSES)
                      .children(t('shell.appearanceLight')),
                    h.option
                      .attr('data-slot', 'native-select-option')
                      .attr('value', 'dark')
                      .class(SELECT_OPTION_CLASSES)
                      .children(t('shell.appearanceDark')),
                  ],
                }),
              }),
              renderField(h, {
                id: 'settings-language',
                label: t('shell.languageLabel'),
                help: t('shell.languageHelp'),
                layout: 'row',
                control: renderNativeSelect(h, {
                  id: 'settings-language',
                  value: h.props.languagePreference,
                  disabled: locked || busy,
                  ariaDescribedBy: 'settings-language-help',
                  size: 'md',
                  width: 'fit',
                  wrapperClass: 'max-w-56 shrink-0',
                  onChange: (value) => SettingsMessage.ChangedLanguage({ value }),
                  options: [
                    h.option
                      .attr('data-slot', 'native-select-option')
                      .attr('value', 'system')
                      .class(SELECT_OPTION_CLASSES)
                      .children(t('shell.languageSystem')),
                    ...h.props.availableLanguages.map((locale) =>
                      h.option
                        .key(locale)
                        .attr('data-slot', 'native-select-option')
                        .attr('value', locale)
                        .attr('lang', localeTag(locale))
                        .class(SELECT_OPTION_CLASSES)
                        .children(languageName(locale)),
                    ),
                  ],
                }),
              }),
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
                (saved.tokenRef === null ? h.label.attr('for', 'settings-token') : h.label)
                  .attr('data-slot', 'label')
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
                        .value(Redacted.value(model.tokenInput))
                        .on('input', ({ value }) =>
                          SettingsMessage.ChangedToken({ value: Redacted.make(value) }),
                        )
                        .on('change', ({ value }) =>
                          SettingsMessage.ChangedToken({ value: Redacted.make(value) }),
                        )
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
                        .class(buttonClasses('ghost', 'icon-lg'))
                        .on('click', SettingsMessage.ClickedToggleShowToken())
                        .children(h.props.showToken ? iconEyeOff(h) : iconEye(h)),
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
                    .class(buttonClasses('secondary', 'lg'))
                    .on('click', SettingsMessage.ClickedGenerateToken())
                    .children(t('settings.generateToken')),
                  h.props.hasMovableKeys &&
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'secondary')
                      .attr('data-size', 'lg')
                      .disabled(locked)
                      .class(buttonClasses('secondary', 'lg'))
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
                  .class(buttonClasses('secondary', 'xl'))
                  .on('click', SettingsMessage.ClickedRevealConfig())
                  .children(t('raw.showInFinder')),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .disabled(locked || busy)
                  .class(buttonClasses('secondary', 'xl'))
                  .on('click', SettingsMessage.ClickedOpenConfigInEditor())
                  .children('Open in External Editor'),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .disabled(locked || busy || dirty)
                  .class(buttonClasses('secondary', 'xl'))
                  .on('click', SettingsMessage.ClickedImportExternalServers())
                  .children('Import Servers from Claude Desktop / Cursor'),
              ),
              importStatus !== null &&
                h.p
                  .attr('role', 'status')
                  .class('m-0 mt-2 text-[12px] text-mac-label-secondary')
                  .children(importStatus),
            ),
          )
        : h.p.children(t('settings.paused')),
    );
  },
});
