import { HtmlLocator, HtmlPlay } from '@effect/ui/html/testing';
import { Locator, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';

import { GatewayRpc } from '@mcp-gateway/mainview/effect-app/services';
import {
  OverviewCommandLayers,
  OverviewEvent,
  type OverviewProps,
  OverviewView,
} from '@mcp-gateway/mainview/effect-overview/OverviewView';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');

const baseProps: typeof OverviewProps.Type = {
  locale: 'en_US',
  hasConfig: true,
  dirty: false,
  running: true,
  revision: 'rev-1',
  listenerAddress: '127.0.0.1:8787',
  configurationLocked: false,
  hasConfigError: false,
  configErrorCode: null,
  error: null,
  operationalError: null,
  keyReminder: false,
  servers: [
    {
      name: 'bear',
      transport: 'http',
      target: 'http://127.0.0.1:4001/mcp',
      disabled: false,
      status: 'mounted',
      hasLive: true,
      liveError: null,
    },
  ],
};

describe('OverviewView Play tests', () => {
  it.effect(
    'exercises server switches, connection testing, timed copy badge expiry, and alerts',
    () => {
      const copied: string[] = [];
      const tested: Array<{ name: string; expectedRevision: string }> = [];

      const rpcLayer = GatewayRpc.test({
        copyClientConfig: ({ name }) =>
          Effect.sync(() => {
            copied.push(name);
            return { ok: true as const, value: null };
          }),
        testServer: ({ name, expectedRevision }) =>
          Effect.sync(() => {
            tested.push({ name, expectedRevision });
            return { ok: true as const, value: { protocolVersion: '2025-11-25' } };
          }),
      });

      const env = Layer.mergeAll(
        TestHost.layer(),
        OverviewCommandLayers.pipe(Layer.provide(rpcLayer)),
      );

      return Effect.gen(function* () {
        const play = yield* HtmlPlay.make(OverviewView, {
          ...baseProps,
          error: 'Could not reach gateway',
          keyReminder: true,
        });

        // Destructive alert and key reminder alert.
        yield* play.expect(HtmlLocator.role('alert')).toHaveText('Could not reach gateway');
        yield* play.click(HtmlLocator.role('button', { name: t('common.dismissError') }));
        yield* play.click(HtmlLocator.role('button', { name: t('keys.review') }));
        yield* play.click(HtmlLocator.role('button', { name: t('keys.dismiss') }));

        // Server table metadata & @effect/ui-kit Switch toggle.
        yield* play.expect(Locator.text('/mcp/bear')).toExist();
        yield* play.expect(Locator.text('127.0.0.1:8787')).toExist();
        yield* play.click(HtmlLocator.role('switch', { name: t('overview.stop') }));

        // Test connection renders passed status.
        yield* play.click(
          HtmlLocator.role('button', { name: t('overview.testConnectionFor', { name: 'bear' }) }),
        );
        assert.deepStrictEqual(tested, [{ name: 'bear', expectedRevision: 'rev-1' }]);
        yield* play
          .expect(Locator.text(t('overview.testPassed', { version: '2025-11-25' })))
          .toExist();

        // Copy client config flips title to "Copied" and expires after 1500ms on TestClock.
        const copyButton = HtmlLocator.role('button', { name: t('overview.copyClientConfig') });
        yield* play.click(copyButton);
        assert.deepStrictEqual(copied, ['bear']);
        yield* play.expect(copyButton).toHaveAttribute('title', 'Copied');

        yield* TestClock.adjust('1500 millis');
        yield* play.expect(copyButton).toHaveAttribute('title', t('overview.copyClientConfig'));

        // Add, edit, delete buttons.
        yield* play.click(HtmlLocator.role('button', { name: t('overview.addServer') }));
        yield* play.click(HtmlLocator.role('button', { name: t('common.editServer') }));
        yield* play.click(
          HtmlLocator.role('button', { name: t('overview.delete', { name: 'bear' }) }),
        );

        assert.deepStrictEqual(play.root.emitted, [
          OverviewEvent.DismissedError(),
          OverviewEvent.RequestedOpenKeyMigration(),
          OverviewEvent.DismissedKeyReminder(),
          OverviewEvent.RequestedToggleServer({ name: 'bear', disabled: true }),
          OverviewEvent.RequestedOpenServerEditor({ name: null }),
          OverviewEvent.RequestedOpenServerEditor({ name: 'bear' }),
          OverviewEvent.RequestedDeleteServer({ name: 'bear' }),
        ]);

        // Operational error alert dismiss.
        const opPlay = yield* HtmlPlay.make(OverviewView, {
          ...baseProps,
          operationalError: { code: 'BridgeTimeout', message: 'Upstream timed out' },
        });
        yield* opPlay
          .expect(HtmlLocator.role('alert'))
          .toHaveText('BridgeTimeout: Upstream timed out');
        yield* opPlay.click(HtmlLocator.role('button', { name: t('common.dismissError') }));
        assert.deepStrictEqual(opPlay.root.emitted, [OverviewEvent.DismissedOperationalError()]);
      }).pipe(Effect.provide(env));
    },
  );

  it.effect('renders empty Bear preset state and repair state vs KeySetupFailed', () => {
    const env = Layer.mergeAll(
      TestHost.layer(),
      OverviewCommandLayers.pipe(Layer.provide(GatewayRpc.test())),
    );

    return Effect.gen(function* () {
      const emptyPlay = yield* HtmlPlay.make(OverviewView, {
        ...baseProps,
        servers: [],
      });
      yield* emptyPlay.expect(Locator.text(t('overview.emptyTitle'))).toExist();
      yield* emptyPlay.click(HtmlLocator.role('button', { name: t('overview.bearPreset') }));
      assert.deepStrictEqual(emptyPlay.root.emitted, [OverviewEvent.RequestedOpenBearPreset()]);

      const repairPlay = yield* HtmlPlay.make(OverviewView, {
        ...baseProps,
        hasConfig: false,
        configErrorCode: 'ConfigReadFailed',
        servers: [],
      });
      yield* repairPlay.expect(Locator.text(t('overview.repairTitle'))).toExist();
      yield* repairPlay
        .expect(HtmlLocator.role('button', { name: t('overview.addServer') }))
        .toHaveAttribute('disabled');

      const keySetupPlay = yield* HtmlPlay.make(OverviewView, {
        ...baseProps,
        hasConfig: false,
        configErrorCode: 'KeySetupFailed',
        servers: [],
      });
      yield* keySetupPlay.expect(Locator.text(t('overview.repairTitle'))).toBeAbsent();
    }).pipe(Effect.provide(env));
  });
});
