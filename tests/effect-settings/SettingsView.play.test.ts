import { HtmlLocator, HtmlPlay } from '@effect/ui/html/testing';
import { Locator, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Redacted } from 'effect';

import {
  SettingsEvent,
  type SettingsProps,
  SettingsView,
} from '@mcp-gateway/mainview/effect-settings/SettingsView';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');

const baseProps: typeof SettingsProps.Type = {
  locale: 'en_US',
  filename: 'mcp.json',
  hasSnapshot: true,
  dirty: false,
  busy: false,
  configurationLocked: false,
  showToken: false,
  error: null,
  operationalError: null,
  revision: 'rev-1',
  appearance: 'system',
  languagePreference: 'system',
  availableLanguages: ['en_US', 'fr_FR'],
  login: { supported: true, enabled: false, error: null },
  retryLogin: false,
  interfaces: [
    { name: 'lo0', address: '127.0.0.1', kind: 'loopback' },
    { name: 'en0', address: '192.168.1.25', kind: 'lan' },
  ],
  hasMovableKeys: true,
  savedConfig: {
    host: '127.0.0.1',
    port: 8787,
    allowedPeers: ['192.168.1.0/24'],
    token: Redacted.make('b'.repeat(64)),
    tokenRef: null,
    launchAtLogin: false,
    autoStart: false,
    keepAwake: false,
  },
  lastImport: null,
};

describe('SettingsView Play tests', () => {
  it.effect(
    'exercises @effect/ui-kit switches, inputs, selects, token generation, and advanced actions',
    () =>
      Effect.gen(function* () {
        const play = yield* HtmlPlay.make(SettingsView, {
          ...baseProps,
          error: 'Validation failed',
        });

        yield* play.expect(HtmlLocator.role('alert')).toHaveText('Validation failed');
        yield* play.click(HtmlLocator.role('button', { name: t('common.dismissError') }));

        // @effect/ui-kit Switch controls expose role="switch" and toggle via click.
        yield* play.click(Locator.attr('id', 'settings-switch-launch-at-login'));
        yield* play.click(Locator.attr('id', 'settings-switch-auto-start'));
        yield* play.click(Locator.attr('id', 'settings-switch-keep-awake'));

        // Appearance and language selects.
        yield* play.change(HtmlLocator.label(t('shell.appearanceLabel')), 'dark');
        yield* play.change(HtmlLocator.label(t('shell.languageLabel')), 'fr_FR');

        // Host commits on blur, port commits on Enter, peers preserves ", ,".
        const hostInput = HtmlLocator.label(t('settings.address'));
        yield* play.type(hostInput, '192.168.1.25');
        yield* play.blur(hostInput);

        const portInput = HtmlLocator.label(t('settings.port'));
        yield* play.type(portInput, '9090');
        yield* play.keydown(portInput, 'Enter');

        const peersInput = HtmlLocator.label(t('settings.peers'));
        yield* play.type(peersInput, ', ,');
        yield* play.blur(peersInput);

        // Token visibility toggle, Generate Token, and Move Keys.
        yield* play.click(HtmlLocator.role('button', { name: t('settings.showToken') }));
        yield* play.click(HtmlLocator.role('button', { name: t('settings.generateToken') }));
        yield* play.click(HtmlLocator.role('button', { name: t('keys.title') }));

        // Advanced buttons and import status from updated lastImport prop.
        yield* play.click(HtmlLocator.role('button', { name: t('raw.showInFinder') }));
        yield* play.click(HtmlLocator.role('button', { name: 'Open in External Editor' }));
        yield* play.click(
          HtmlLocator.role('button', { name: 'Import Servers from Claude Desktop / Cursor' }),
        );

        play.root.setProps({
          ...baseProps,
          lastImport: { seq: 1, count: 2 },
        });
        yield* TestHost.settle;
        yield* play
          .expect(HtmlLocator.role('status'))
          .toHaveText('Imported 2 servers from Claude Desktop / Cursor.');

        const tags = play.root.emitted.map((e) => e._tag);
        assert.deepStrictEqual(tags, [
          'DismissedError',
          'CommittedGatewayMutation',
          'CommittedGatewayMutation',
          'CommittedGatewayMutation',
          'ChangedAppearance',
          'ChangedLanguage',
          'CommittedGatewayMutation',
          'CommittedGatewayMutation',
          'CommittedGatewayMutation',
          'ToggledShowToken',
          'CommittedGatewayMutation',
          'RequestedOpenKeyMigration',
          'RequestedRevealConfig',
          'RequestedOpenConfigInEditor',
          'RequestedImportExternalServers',
        ]);

        // Operational error alert dismiss.
        const opPlay = yield* HtmlPlay.make(SettingsView, {
          ...baseProps,
          operationalError: { code: 'BridgeIO', message: 'Disk full' },
        });
        yield* opPlay.expect(HtmlLocator.role('alert')).toHaveText('BridgeIO: Disk full');
        yield* opPlay.click(HtmlLocator.role('button', { name: t('common.dismissError') }));
        assert.deepStrictEqual(opPlay.root.emitted, [SettingsEvent.DismissedOperationalError()]);
      }).pipe(Effect.provide(TestHost.layer())),
  );

  it.effect(
    'renders Keychain tokenRef, needsLoginRetry, and paused state when savedConfig is null',
    () =>
      Effect.gen(function* () {
        const play = yield* HtmlPlay.make(SettingsView, {
          ...baseProps,
          login: { supported: true, enabled: false, error: 'Approval required' },
          retryLogin: true,
          hasMovableKeys: false,
          savedConfig: {
            host: '127.0.0.1',
            port: 8787,
            allowedPeers: ['192.168.1.0/24'],
            launchAtLogin: true,
            autoStart: false,
            keepAwake: false,
            token: null,
            tokenRef: 'gateway:default',
          },
        });

        yield* play.expect(Locator.text('Approval required')).toExist();
        yield* play.expect(Locator.text(t('keys.stored'))).toExist();
        yield* play.expect(HtmlLocator.role('button', { name: t('keys.title') })).toBeAbsent();

        yield* play.click(HtmlLocator.role('button', { name: t('draft.retryLogin') }));
        assert.deepStrictEqual(play.root.emitted, [
          SettingsEvent.CommittedGatewayMutation({
            mutation: { _tag: 'SetLaunchAtLogin', value: true },
          }),
        ]);

        // Paused config view.
        const pausedPlay = yield* HtmlPlay.make(SettingsView, {
          ...baseProps,
          savedConfig: null,
        });
        yield* pausedPlay.expect(Locator.text(t('settings.paused'))).toExist();
      }).pipe(Effect.provide(TestHost.layer())),
  );
});
