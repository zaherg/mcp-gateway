import { HtmlPlay } from '@effect/ui/html/testing';
import { Locator, Story, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import type { UpdateStatusValue } from '@mcp-gateway/mainview/effect-app/schemas';
import {
  formatBytes,
  UpdatesEvent,
  UpdatesMessage,
  type UpdatesProps,
  UpdatesView,
  updateStatusText,
} from '@mcp-gateway/mainview/effect-updates/UpdatesView';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');

const makeUpdate = (overrides: Partial<UpdateStatusValue> = {}): UpdateStatusValue => ({
  supported: true,
  automaticUpdates: true,
  installedVersion: '1.0.0',
  availableVersion: null,
  phase: 'idle',
  error: null,
  checkedAt: null,
  ...overrides,
});

const makeProps = (
  overrides: Partial<typeof UpdatesProps.Type> = {},
): typeof UpdatesProps.Type => ({
  locale: 'en_US',
  updateState: makeUpdate(),
  busy: false,
  updateBusy: false,
  configurationLocked: false,
  error: null,
  ...overrides,
});

describe('UpdatesView', () => {
  it('auto-checks once on idle supported init and does not auto-check when unsupported or non-idle', () => {
    const idleStory = Story.start(
      UpdatesView,
      makeProps({ updateState: makeUpdate({ phase: 'idle' }) }),
    );
    assert.isTrue(idleStory.model.autoChecked);
    idleStory.emitted(UpdatesEvent.RequestedCheck());

    const readyStory = Story.start(
      UpdatesView,
      makeProps({ updateState: makeUpdate({ phase: 'ready', availableVersion: '1.1.0' }) }),
    );
    assert.isFalse(readyStory.model.autoChecked);
    assert.deepStrictEqual(readyStory.current.emitted, []);

    const unsupportedStory = Story.start(
      UpdatesView,
      makeProps({ updateState: makeUpdate({ supported: false, phase: 'idle' }) }),
    );
    assert.isFalse(unsupportedStory.model.autoChecked);
    assert.deepStrictEqual(unsupportedStory.current.emitted, []);
  });

  it('emits RequestedInstall when available and RequestedRestart when ready', () => {
    const availStory = Story.start(
      UpdatesView,
      makeProps({ updateState: makeUpdate({ phase: 'available', availableVersion: '1.1.0' }) }),
    );
    availStory.send(UpdatesMessage.ClickedInstallOrRelaunch());
    availStory.emitted(UpdatesEvent.RequestedInstall());

    const readyStory = Story.start(
      UpdatesView,
      makeProps({ updateState: makeUpdate({ phase: 'ready', availableVersion: '1.1.0' }) }),
    );
    readyStory.send(UpdatesMessage.ClickedInstallOrRelaunch());
    readyStory.emitted(UpdatesEvent.RequestedRestart());
  });

  it.effect('renders progressbar ARIA attributes and byte/percent label during download', () =>
    Effect.gen(function* () {
      const play = yield* HtmlPlay.make(
        UpdatesView,
        makeProps({
          updateState: makeUpdate({
            phase: 'downloading',
            availableVersion: '1.2.0',
            progressPercent: 45,
            downloadedBytes: 512 * 1024,
            totalBytes: 2 * 1024 * 1024,
          }),
        }),
      );
      yield* play.expect(Locator.text('45% · 512.0 KB / 2.0 MB')).toExist();
      yield* play.expect(Locator.text(t('updates.downloadingButton'))).toExist();
      assert.strictEqual(formatBytes(500), '500 B');
      assert.strictEqual(
        updateStatusText(makeUpdate({ phase: 'available', availableVersion: '2.0.0' }), t),
        t('updates.status.availableVersion', { version: '2.0.0' }),
      );
    }).pipe(Effect.provide(TestHost.layer())),
  );
});
