import { HtmlPlay } from '@effect/ui/html/testing';
import { Locator, Story, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
  KeyMigrationEvent,
  KeyMigrationMessage,
  type KeyMigrationProps,
  KeyMigrationView,
} from '@mcp-gateway/mainview/effect-dialogs/KeyMigrationView';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');

const makeProps = (
  overrides: Partial<typeof KeyMigrationProps.Type> = {},
): typeof KeyMigrationProps.Type => ({
  locale: 'en_US',
  slots: { gateway: true, servers: ['bear'] },
  dirty: false,
  busy: false,
  status: 'idle',
  error: null,
  filename: 'mcp.json',
  ...overrides,
});

describe('KeyMigrationView', () => {
  it('freezes reviewed slots on Continue so later live slot changes are not moved', () => {
    const story = Story.start(KeyMigrationView, makeProps());
    assert.strictEqual(story.model.step, 'what');

    story.send(KeyMigrationMessage.ClickedContinue());
    assert.strictEqual(story.model.step, 'confirm');
    assert.deepStrictEqual(story.model.reviewed, { gateway: true, servers: ['bear'] });

    // Even if live props gain a new server, clicking Move sends the frozen reviewed slots
    story.props(makeProps({ slots: { gateway: true, servers: ['bear', 'late-server'] } }));
    story.send(KeyMigrationMessage.ClickedMove());
    story.emitted(KeyMigrationEvent.RequestedMove({ slots: { gateway: true, servers: ['bear'] } }));

    // Try Again after failure resets to step 1 so new list must be reviewed
    story.props(makeProps({ status: 'failed', error: 'Keychain denied' }));
    story.send(KeyMigrationMessage.ClickedTryAgain());
    assert.strictEqual(story.model.step, 'what');
    assert.isTrue(story.model.dismissedResult);
  });

  it.effect('renders masked secret badges and enforces dirty guard until done', () =>
    Effect.gen(function* () {
      const reviewPlay = yield* HtmlPlay.make(KeyMigrationView, makeProps());
      yield* reviewPlay.expect(Locator.text('••••••••')).toExist();
      yield* reviewPlay.expect(Locator.text(t('keys.global'))).toExist();

      const dirtyPlay = yield* HtmlPlay.make(KeyMigrationView, makeProps({ dirty: true }));
      yield* dirtyPlay.expect(Locator.text(t('keys.saveFirst'))).toExist();

      const donePlay = yield* HtmlPlay.make(
        KeyMigrationView,
        makeProps({ dirty: true, status: 'done' }),
      );
      yield* donePlay.expect(Locator.text(t('keys.moved'))).toExist();
    }).pipe(Effect.provide(TestHost.layer())),
  );
});
