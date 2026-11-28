import { HtmlPlay } from '@effect/ui/html/testing';
import { Locator, Story, TestHost } from '@effect/ui/testing';
import { describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
  WhatsNewEvent,
  WhatsNewMessage,
  WhatsNewView,
} from '@mcp-gateway/mainview/effect-dialogs/WhatsNewView';

const SAMPLE_CHANGELOG = `# Changelog

## [1.2.3] - 2026-04-01

### Added
- Support for \`--mcp\` and **bold text** with [docs link](https://example.com)
`;

describe('WhatsNewView', () => {
  it.effect('renders inline code, bold, and strips link URLs while emitting Closed', () =>
    Effect.gen(function* () {
      const play = yield* HtmlPlay.make(WhatsNewView, {
        locale: 'en_US',
        version: '1.2.3',
        changelogText: SAMPLE_CHANGELOG,
      });
      yield* play.expect(Locator.text('--mcp')).toExist();
      yield* play.expect(Locator.text('bold text')).toExist();
      yield* play.expect(Locator.text('docs link')).toExist();
      yield* play.expect(Locator.text('https://example.com')).toBeAbsent();
    }).pipe(Effect.provide(TestHost.layer())),
  );

  it('emits Closed when dismissed', () => {
    const story = Story.start(WhatsNewView, {
      locale: 'en_US',
      version: '1.2.3',
      changelogText: SAMPLE_CHANGELOG,
    });
    story.send(WhatsNewMessage.Closed());
    story.emitted(WhatsNewEvent.Closed());
  });
});
