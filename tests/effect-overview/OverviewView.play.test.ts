import { HtmlLocator, HtmlPlay } from '@effect/ui/html/testing';
import { Locator, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';

import {
  OverviewCommandLayers,
  type OverviewProps,
  OverviewView,
} from '@mcp-gateway/mainview/effect-overview/OverviewView';
import { OverviewActions, TestServerOutcome } from '@mcp-gateway/mainview/effect-overview/services';
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
      const toggled: Array<{ name: string; disabled: boolean }> = [];
      const edited: Array<string | null> = [];
      const deleted: string[] = [];
      const copied: string[] = [];
      const tested: Array<{ name: string; revision: string }> = [];
      let clearErrorCalls = 0;
      let dismissOpErrorCalls = 0;
      let dismissReminderCalls = 0;
      let openKeyMigrationCalls = 0;

      const actionsLayer = Layer.succeed(OverviewActions, {
        clearError: () =>
          Effect.sync(() => {
            clearErrorCalls++;
          }),
        dismissOperationalError: () =>
          Effect.sync(() => {
            dismissOpErrorCalls++;
          }),
        dismissKeyReminder: () =>
          Effect.sync(() => {
            dismissReminderCalls++;
          }),
        openKeyMigration: () =>
          Effect.sync(() => {
            openKeyMigrationCalls++;
          }),
        openServerEditor: (name) =>
          Effect.sync(() => {
            edited.push(name);
          }),
        openBearPreset: () => Effect.void,
        toggleServer: (name, disabled) =>
          Effect.sync(() => {
            toggled.push({ name, disabled });
          }),
        deleteServer: (name) =>
          Effect.sync(() => {
            deleted.push(name);
          }),
        copyClientConfig: (name) =>
          Effect.sync(() => {
            copied.push(name);
            return true;
          }),
        testServer: (name, expectedRevision) =>
          Effect.sync(() => {
            tested.push({ name, revision: expectedRevision });
            return TestServerOutcome.Passed({ protocolVersion: '2025-11-25' });
          }),
      });

      const env = Layer.mergeAll(
        TestHost.layer(),
        OverviewCommandLayers.pipe(Layer.provide(actionsLayer)),
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
        assert.strictEqual(clearErrorCalls, 1);

        yield* play.click(HtmlLocator.role('button', { name: t('keys.review') }));
        assert.strictEqual(openKeyMigrationCalls, 1);

        yield* play.click(HtmlLocator.role('button', { name: t('keys.dismiss') }));
        assert.strictEqual(dismissReminderCalls, 1);

        // Server table metadata & @effect/ui-kit Switch toggle.
        yield* play.expect(Locator.text('/mcp/bear')).toExist();
        yield* play.expect(Locator.text('127.0.0.1:8787')).toExist();
        yield* play.click(HtmlLocator.role('switch', { name: t('overview.stop') }));
        assert.deepStrictEqual(toggled, [{ name: 'bear', disabled: true }]);

        // Test connection renders passed status.
        yield* play.click(
          HtmlLocator.role('button', { name: t('overview.testConnectionFor', { name: 'bear' }) }),
        );
        assert.deepStrictEqual(tested, [{ name: 'bear', revision: 'rev-1' }]);
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
        assert.deepStrictEqual(edited, [null, 'bear']);
        assert.deepStrictEqual(deleted, ['bear']);

        // Operational error alert dismiss.
        const opPlay = yield* HtmlPlay.make(OverviewView, {
          ...baseProps,
          operationalError: { code: 'BridgeTimeout', message: 'Upstream timed out' },
        });
        yield* opPlay
          .expect(HtmlLocator.role('alert'))
          .toHaveText('BridgeTimeout: Upstream timed out');
        yield* opPlay.click(HtmlLocator.role('button', { name: t('common.dismissError') }));
        assert.strictEqual(dismissOpErrorCalls, 1);
      }).pipe(Effect.provide(env));
    },
  );

  it.effect('renders empty Bear preset state and repair state vs KeySetupFailed', () => {
    let bearPresetCalls = 0;
    const actionsLayer = Layer.succeed(OverviewActions, {
      clearError: () => Effect.void,
      dismissOperationalError: () => Effect.void,
      dismissKeyReminder: () => Effect.void,
      openKeyMigration: () => Effect.void,
      openServerEditor: () => Effect.void,
      openBearPreset: () =>
        Effect.sync(() => {
          bearPresetCalls++;
        }),
      toggleServer: () => Effect.void,
      deleteServer: () => Effect.void,
      copyClientConfig: () => Effect.succeed(true),
      testServer: () => Effect.succeed(TestServerOutcome.Passed({ protocolVersion: '2025-11-25' })),
    });

    const env = Layer.mergeAll(
      TestHost.layer(),
      OverviewCommandLayers.pipe(Layer.provide(actionsLayer)),
    );

    return Effect.gen(function* () {
      const emptyPlay = yield* HtmlPlay.make(OverviewView, {
        ...baseProps,
        servers: [],
      });
      yield* emptyPlay.expect(Locator.text(t('overview.emptyTitle'))).toExist();
      yield* emptyPlay.click(HtmlLocator.role('button', { name: t('overview.bearPreset') }));
      assert.strictEqual(bearPresetCalls, 1);

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
