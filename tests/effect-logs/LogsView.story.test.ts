import { Component } from '@effect/ui';
import { Story } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';

import {
  ClearLogs,
  CopyLogEntry,
  ExpireCopyBadge,
  LogsMessage,
  LogsView,
  ReadLogsPage,
  SchedulePollWait,
  ScrollToBottom,
} from '@mcp-gateway/mainview/effect-logs/LogsView';
import { translator } from '@mcp-gateway/shared/i18n';
import type { LogEntry, LogPage } from '@mcp-gateway/shared/types';

const defaultProps = { servers: ['bear', 'remote'], locale: 'en_US' };
const t = translator('en_US');

const sampleEntry: LogEntry = {
  id: 1,
  time: '2026-11-28T10:00:01Z',
  server: 'bear',
  level: 'info',
  source: 'controller',
  text: 'Mounted bear stdio backend',
  truncated: false,
};

const pageWithMore: LogPage = {
  entries: [sampleEntry],
  cursor: 1,
  generation: 1,
  gap: false,
  hasMore: true,
};

const emptyCleanPage: LogPage = {
  entries: [],
  cursor: 0,
  generation: 2,
  gap: false,
  hasMore: false,
};

describe('LogsView Story tests', () => {
  it('polls immediately on init, drains hasMore at 0ms, and retries after error', () => {
    const story = Story.start(LogsView, defaultProps);
    story
      .expectExact(ReadLogsPage.make({ after: 0 }))
      .resolve(ReadLogsPage, LogsMessage.PollFailed({ kind: 'rpc', message: 'LogIO: busy' }))
      .expectExact(SchedulePollWait.make({ delayMs: 2000 }));
    assert.strictEqual(story.model.readError, 'LogIO: busy');

    story
      .resolve(SchedulePollWait, LogsMessage.PollTicked())
      .expectExact(ReadLogsPage.make({ after: 0 }))
      .resolve(ReadLogsPage, LogsMessage.PollSucceeded({ page: pageWithMore }))
      .expectExact(SchedulePollWait.make({ delayMs: 0 }), ScrollToBottom.make())
      .resolve(ScrollToBottom, Component.noop);

    assert.strictEqual(story.model.readError, null);
    assert.strictEqual(story.model.entries.length, 1);
    assert.strictEqual(story.model.cursor, 1);
  });

  it('interrupts polling on Clear, keeps entries on failure, and resets on success', () => {
    const story = Story.start(LogsView, defaultProps);
    story
      .expectExact(ReadLogsPage.make({ after: 0 }))
      .resolve(
        ReadLogsPage,
        LogsMessage.PollSucceeded({
          page: { ...pageWithMore, hasMore: false },
        }),
      )
      .expectExact(SchedulePollWait.make({ delayMs: 2000 }), ScrollToBottom.make())
      .resolve(ScrollToBottom, Component.noop)
      .keepPending(SchedulePollWait);

    story.send(LogsMessage.ClickedClear()).expectExact(ClearLogs.make());
    assert.strictEqual(story.model.pollPhase, 'clearing');

    story
      .resolve(ClearLogs, LogsMessage.ClearFailed({ kind: 'bridge', message: 'timeout' }))
      .expectExact(ReadLogsPage.make({ after: 1 }))
      .keepPending(ReadLogsPage);
    assert.strictEqual(story.model.clearError, t('logs.clearFailed'));
    assert.strictEqual(story.model.entries.length, 1);
    assert.strictEqual(story.model.pollPhase, 'polling');

    story
      .send(LogsMessage.ClickedClear())
      .expectExact(ClearLogs.make())
      .resolve(ClearLogs, LogsMessage.ClearSucceeded())
      .expectExact(ReadLogsPage.make({ after: 0 }));
    assert.strictEqual(story.model.entries.length, 0);
    assert.strictEqual(story.model.cursor, 0);
    assert.strictEqual(story.model.gap, false);
    assert.strictEqual(story.model.clearError, null);
    assert.strictEqual(story.model.pollPhase, 'polling');
  });

  it('tracks copy badge expiry without stale overwrites', () => {
    const story = Story.start(LogsView, defaultProps);
    story
      .expectExact(ReadLogsPage.make({ after: 0 }))
      .resolve(ReadLogsPage, LogsMessage.PollSucceeded({ page: emptyCleanPage }))
      .expectExact(SchedulePollWait.make({ delayMs: 2000 }))
      .keepPending(SchedulePollWait);

    story
      .send(LogsMessage.ClickedCopy({ entryId: 1, text: 'line 1' }))
      .expectExact(
        SchedulePollWait.make({ delayMs: 2000 }),
        CopyLogEntry.make({ entryId: 1, text: 'line 1' }),
      )
      .resolve(CopyLogEntry, LogsMessage.CopyCompleted({ entryId: 1, copied: true }))
      .expectExact(SchedulePollWait.make({ delayMs: 2000 }), ExpireCopyBadge.make({ entryId: 1 }))
      .keepPending(SchedulePollWait)
      .keepPending(ExpireCopyBadge);
    assert.strictEqual(story.model.copiedId, 1);

    story.send(LogsMessage.CopyBadgeExpired({ entryId: 99 }));
    assert.strictEqual(story.model.copiedId, 1);

    story.resolve(ExpireCopyBadge, LogsMessage.CopyBadgeExpired({ entryId: 1 }));
    assert.strictEqual(story.model.copiedId, null);
  });

  it('exhaustively explores overlapping poll and clear settlement orders', () => {
    const explored = Story.explore(LogsView, defaultProps, {
      messages: [LogsMessage.ClickedClear(), LogsMessage.DismissedReadError()],
      commands: [
        [
          ReadLogsPage,
          {
            success: () => [
              LogsMessage.PollSucceeded({ page: { ...pageWithMore, hasMore: false } }),
              LogsMessage.PollSucceeded({ page: emptyCleanPage }),
              LogsMessage.PollFailed({ kind: 'rpc', message: 'LogIO: busy' }),
            ],
          },
        ],
        [SchedulePollWait, { success: () => [LogsMessage.PollTicked()] }],
        [
          ClearLogs,
          {
            success: () => [
              LogsMessage.ClearSucceeded(),
              LogsMessage.ClearFailed({ kind: 'rpc', message: 'ClearDenied: locked' }),
            ],
          },
        ],
        [ScrollToBottom, { success: () => [] }],
      ],
      depth: 5,
      transition: ({ before, message, after }) => {
        if (before.pollPhase === 'clearing' && message._tag === 'PollSucceeded') {
          assert.deepStrictEqual(after.entries, before.entries);
          assert.strictEqual(after.cursor, before.cursor);
        }
        if (message._tag === 'ClearSucceeded') {
          assert.strictEqual(after.entries.length, 0);
          assert.strictEqual(after.cursor, 0);
          assert.strictEqual(after.pollPhase, 'polling');
        }
      },
      invariant: ({ model, pending }) => {
        if (model.pollPhase === 'clearing') {
          assert.strictEqual(
            pending.some((item) => item.command.name === ReadLogsPage.name),
            false,
          );
          assert.strictEqual(
            pending.some((item) => item.command.name === SchedulePollWait.name),
            false,
          );
        }
      },
    });
    assert.isAbove(explored.states, 10);
  });
});
