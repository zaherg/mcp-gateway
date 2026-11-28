import { HtmlLocator, HtmlPlay } from '@effect/ui/html/testing';
import { Locator, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Redacted } from 'effect';

import {
  SettingsCommandLayers,
  type SettingsProps,
  SettingsView,
} from '@mcp-gateway/mainview/effect-settings/SettingsView';
import {
  type GatewayMutationValue,
  SettingsActions,
} from '@mcp-gateway/mainview/effect-settings/services';
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
};

describe('SettingsView Play tests', () => {
  it.effect(
    'exercises @effect/ui-kit switches, inputs, selects, token generation, and advanced actions',
    () => {
      const mutations: GatewayMutationValue[] = [];
      const appearances: string[] = [];
      const languages: string[] = [];
      const showTokenCalls: boolean[] = [];
      let revealCalls = 0;
      let editorCalls = 0;
      let keyMigrationCalls = 0;
      let dismissErrorCalls = 0;
      let dismissOpErrorCalls = 0;
      const generatedToken = Redacted.make('f'.repeat(64));

      const actionsLayer = Layer.succeed(SettingsActions, {
        commitGatewayMutation: (mutation) =>
          Effect.sync(() => {
            mutations.push(mutation);
          }),
        clearError: () =>
          Effect.sync(() => {
            dismissErrorCalls++;
          }),
        dismissOperationalError: () =>
          Effect.sync(() => {
            dismissOpErrorCalls++;
          }),
        setShowToken: (show) =>
          Effect.sync(() => {
            showTokenCalls.push(show);
          }),
        openKeyMigration: () =>
          Effect.sync(() => {
            keyMigrationCalls++;
          }),
        changeLanguage: (preference) =>
          Effect.sync(() => {
            languages.push(preference);
          }),
        changeAppearance: (preference) =>
          Effect.sync(() => {
            appearances.push(preference);
          }),
        revealConfig: () =>
          Effect.sync(() => {
            revealCalls++;
          }),
        openConfigInEditor: () =>
          Effect.sync(() => {
            editorCalls++;
          }),
        importExternalServers: () => Effect.succeed(2),
        generateToken: () => Effect.succeed(generatedToken),
      });

      const env = Layer.mergeAll(
        TestHost.layer(),
        SettingsCommandLayers.pipe(Layer.provide(actionsLayer)),
      );

      return Effect.gen(function* () {
        const play = yield* HtmlPlay.make(SettingsView, {
          ...baseProps,
          error: 'Validation failed',
        });

        yield* play.expect(HtmlLocator.role('alert')).toHaveText('Validation failed');
        yield* play.click(HtmlLocator.role('button', { name: t('common.dismissError') }));
        assert.strictEqual(dismissErrorCalls, 1);

        // @effect/ui-kit Switch controls expose role="switch" and toggle via click.
        yield* play.click(Locator.attr('id', 'settings-switch-launch-at-login'));
        yield* play.click(Locator.attr('id', 'settings-switch-auto-start'));
        yield* play.click(Locator.attr('id', 'settings-switch-keep-awake'));
        assert.deepStrictEqual(
          mutations.map((m) => m._tag),
          ['SetLaunchAtLogin', 'SetAutoStart', 'SetKeepAwake'],
        );

        // Appearance and language selects.
        yield* play.change(HtmlLocator.label(t('shell.appearanceLabel')), 'dark');
        yield* play.change(HtmlLocator.label(t('shell.languageLabel')), 'fr_FR');
        assert.deepStrictEqual(appearances, ['dark']);
        assert.deepStrictEqual(languages, ['fr_FR']);

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

        assert.deepStrictEqual(mutations.slice(3), [
          { _tag: 'SetHost', host: '192.168.1.25' },
          { _tag: 'SetPort', port: 9090 },
          { _tag: 'SetAllowedPeers', allowedPeers: [] },
        ]);

        // Token visibility toggle, Generate Token, and Move Keys.
        yield* play.click(HtmlLocator.role('button', { name: t('settings.showToken') }));
        assert.deepStrictEqual(showTokenCalls, [true]);

        yield* play.click(HtmlLocator.role('button', { name: t('settings.generateToken') }));
        const lastMutation = mutations[mutations.length - 1];
        assert.strictEqual(lastMutation?._tag, 'ReplaceTokenWithLiteral');
        if (lastMutation?._tag === 'ReplaceTokenWithLiteral') {
          assert.strictEqual(Redacted.value(lastMutation.token), Redacted.value(generatedToken));
        }

        yield* play.click(HtmlLocator.role('button', { name: t('keys.title') }));
        assert.strictEqual(keyMigrationCalls, 1);

        // Advanced buttons and import status.
        yield* play.click(HtmlLocator.role('button', { name: t('raw.showInFinder') }));
        yield* play.click(HtmlLocator.role('button', { name: 'Open in External Editor' }));
        yield* play.click(
          HtmlLocator.role('button', { name: 'Import Servers from Claude Desktop / Cursor' }),
        );
        assert.strictEqual(revealCalls, 1);
        assert.strictEqual(editorCalls, 1);
        yield* play
          .expect(HtmlLocator.role('status'))
          .toHaveText('Imported 2 servers from Claude Desktop / Cursor.');

        // Operational error alert dismiss.
        const opPlay = yield* HtmlPlay.make(SettingsView, {
          ...baseProps,
          operationalError: { code: 'BridgeIO', message: 'Disk full' },
        });
        yield* opPlay.expect(HtmlLocator.role('alert')).toHaveText('BridgeIO: Disk full');
        yield* opPlay.click(HtmlLocator.role('button', { name: t('common.dismissError') }));
        assert.strictEqual(dismissOpErrorCalls, 1);
      }).pipe(Effect.provide(env));
    },
  );

  it.effect(
    'renders Keychain tokenRef, needsLoginRetry, and paused state when savedConfig is null',
    () => {
      const mutations: GatewayMutationValue[] = [];
      const env = Layer.mergeAll(
        TestHost.layer(),
        SettingsCommandLayers.pipe(
          Layer.provide(
            Layer.succeed(SettingsActions, {
              commitGatewayMutation: (mutation) =>
                Effect.sync(() => {
                  mutations.push(mutation);
                }),
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
            }),
          ),
        ),
      );

      return Effect.gen(function* () {
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
        assert.deepStrictEqual(mutations, [{ _tag: 'SetLaunchAtLogin', value: true }]);

        // Paused config view.
        const pausedPlay = yield* HtmlPlay.make(SettingsView, {
          ...baseProps,
          savedConfig: null,
        });
        yield* pausedPlay.expect(Locator.text(t('settings.paused'))).toExist();
      }).pipe(Effect.provide(env));
    },
  );
});
