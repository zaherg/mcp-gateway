import { Component } from '@effect/ui';
import { HtmlLocator, HtmlScene } from '@effect/ui/html/testing';
import { Locator } from '@effect/ui/testing';
import { describe, it } from '@effect/vitest';

import {
  ClearLogs,
  FocusSearch,
  LogsMessage,
  LogsView,
  ReadLogsPage,
  SchedulePollWait,
  ScrollToBottom,
} from '@mcp-gateway/mainview/effect-logs/LogsView';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');
const defaultProps = { servers: ['bear'], locale: 'en_US' };

describe('LogsView Scene tests', () => {
  it('disables Clear while ClearLogs is running and toggles toolbar controls', () => {
    const scene = HtmlScene.start(LogsView, defaultProps);
    scene
      .expectExact(ReadLogsPage.make({ after: 0 }))
      .resolve(
        ReadLogsPage,
        LogsMessage.PollSucceeded({
          page: {
            entries: [
              {
                id: 1,
                time: '2026-11-28T10:00:01Z',
                server: 'bear',
                level: 'info',
                source: 'controller',
                text: 'Mounted bear stdio backend',
                truncated: false,
              },
            ],
            cursor: 1,
            generation: 1,
            gap: false,
            hasMore: false,
          },
        }),
      )
      .expectExact(SchedulePollWait.make({ delayMs: 2000 }), ScrollToBottom.make())
      .resolve(ScrollToBottom, Component.noop)
      .keepPending(SchedulePollWait)
      .expect(Locator.text('Mounted bear stdio backend'))
      .toExist();

    const clearButton = HtmlLocator.role('button', { name: t('logs.clear') });
    scene
      .click(clearButton)
      .expectExact(ClearLogs.make())
      .expect(clearButton)
      .toBeDisabled()
      .resolve(ClearLogs, LogsMessage.ClearSucceeded())
      .expectExact(ReadLogsPage.make({ after: 0 }))
      .keepPending(ReadLogsPage)
      .expect(clearButton)
      .toBeDisabled(false)
      .expect(Locator.text(t('logs.empty')))
      .toExist();

    const infoButton = HtmlLocator.role('button', { name: t('logs.sensitiveTitle') });
    scene
      .click(infoButton)
      .expect(Locator.text(t('logs.sensitiveBody')))
      .toExist();

    const followTailButton = HtmlLocator.role('button', { name: 'Follow Tail' });
    scene
      .expect(followTailButton)
      .toHaveAttribute('aria-pressed', 'true')
      .click(followTailButton)
      .expect(followTailButton)
      .toHaveAttribute('aria-pressed', 'false')
      .click(followTailButton)
      .expectExact(ReadLogsPage.make({ after: 0 }), ScrollToBottom.make())
      .resolve(ScrollToBottom, Component.noop)
      .expect(followTailButton)
      .toHaveAttribute('aria-pressed', 'true');

    scene
      .fireDocument('keydown', { key: 'f', meta: true })
      .expectExact(ReadLogsPage.make({ after: 0 }), FocusSearch.make())
      .resolve(FocusSearch, Component.noop);
  });
});
