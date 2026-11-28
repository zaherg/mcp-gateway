import { HtmlLocator, HtmlPlay, TestGlobalEvents } from '@effect/ui/html/testing';
import { Locator, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';

import { LogsCommandLayers, LogsView } from '@mcp-gateway/mainview/effect-logs/LogsView';
import { LogRpcError, LogsDom, LogsRpc } from '@mcp-gateway/mainview/effect-logs/services';
import { translator } from '@mcp-gateway/shared/i18n';
import type { LogEntry, LogPage } from '@mcp-gateway/shared/types';

const t = translator('en_US');

const entriesPage1: LogEntry[] = [
  {
    id: 1,
    time: '2026-11-28T10:00:01Z',
    server: 'bear',
    level: 'info',
    source: 'controller',
    text: 'Mounted bear stdio backend',
    truncated: false,
  },
  {
    id: 2,
    time: '2026-11-28T10:00:02Z',
    server: 'remote',
    level: 'error',
    source: 'stderr',
    text: 'Connection timeout talking to remote',
    truncated: true,
  },
];

const entriesPage2: LogEntry[] = [
  {
    id: 3,
    time: '2026-11-28T10:00:03Z',
    server: null,
    level: 'warn',
    source: 'logger',
    text: 'Gateway listener retrying bind',
    truncated: false,
  },
];

describe('LogsView Play tests', () => {
  it.effect(
    'runs full poll retry, hasMore drain, Cmd+F focus, filters, clear error recovery, and copy timer on TestClock',
    () => {
      let readCalls = 0;
      let clearCalls = 0;
      let clearMode: 'rpcError' | 'bridgeError' | 'ok' = 'rpcError';
      let cleared = false;
      let focusCount = 0;
      let scrollBottomCount = 0;
      const copiedTexts: string[] = [];

      const testRpc = Layer.succeed(LogsRpc, {
        readLogs: ({ after }) =>
          Effect.suspend(() => {
            readCalls++;
            if (cleared) {
              return Effect.succeed<LogPage>({
                entries: [],
                cursor: 0,
                generation: 2,
                gap: false,
                hasMore: false,
              });
            }
            if (readCalls === 1) {
              return Effect.fail(
                new LogRpcError({ kind: 'rpc', message: 'LogIO: Log buffer temporarily busy' }),
              );
            }
            if (after === 0) {
              return Effect.succeed<LogPage>({
                entries: entriesPage1,
                cursor: 2,
                generation: 1,
                gap: true,
                hasMore: true,
              });
            }
            if (after === 2) {
              return Effect.succeed<LogPage>({
                entries: entriesPage2,
                cursor: 3,
                generation: 1,
                gap: false,
                hasMore: false,
              });
            }
            return Effect.succeed<LogPage>({
              entries: [],
              cursor: 3,
              generation: 1,
              gap: false,
              hasMore: false,
            });
          }),
        clearLogs: () =>
          Effect.suspend(() => {
            clearCalls++;
            if (clearMode === 'rpcError') {
              return Effect.fail(
                new LogRpcError({ kind: 'rpc', message: 'ClearDenied: Log ring locked' }),
              );
            }
            if (clearMode === 'bridgeError') {
              return Effect.fail(new LogRpcError({ kind: 'bridge', message: 'bridge offline' }));
            }
            cleared = true;
            return Effect.succeed<LogPage>({
              entries: [],
              cursor: 0,
              generation: 2,
              gap: false,
              hasMore: false,
            });
          }),
      });

      const testDom = Layer.succeed(LogsDom, {
        focusSearchInput: () =>
          Effect.sync(() => {
            focusCount++;
          }),
        scrollToBottom: () =>
          Effect.sync(() => {
            scrollBottomCount++;
          }),
        isScrolledToBottom: () => Effect.succeed(true),
        copyText: (text) =>
          Effect.sync(() => {
            copiedTexts.push(text);
            return true;
          }),
      });

      const env = Layer.mergeAll(
        TestHost.layer(),
        TestGlobalEvents.layer,
        LogsCommandLayers.pipe(Layer.provide(Layer.mergeAll(testRpc, testDom))),
      );

      return Effect.gen(function* () {
        const play = yield* HtmlPlay.make(LogsView, {
          servers: ['bear', 'remote'],
          locale: 'en_US',
        });

        yield* play
          .expect(HtmlLocator.role('alert'))
          .toHaveText('LogIO: Log buffer temporarily busy');
        assert.strictEqual(readCalls, 1);

        yield* TestClock.adjust('2 seconds');
        yield* play.expect(HtmlLocator.role('alert')).toBeAbsent();
        yield* play.expect(HtmlLocator.role('status')).toHaveText(t('logs.gap'));
        yield* play.expect(Locator.text('Mounted bear stdio backend')).toExist();
        yield* play
          .expect(Locator.text(`Connection timeout talking to remote (${t('logs.truncated')})`))
          .toExist();
        yield* play.expect(Locator.text('Gateway listener retrying bind')).toExist();
        assert.strictEqual(readCalls, 3);
        assert.isAbove(scrollBottomCount, 0);

        yield* TestGlobalEvents.fire('document', 'keydown', { key: 'f', meta: true });
        yield* TestHost.settle;
        assert.strictEqual(focusCount, 1);

        const levelSelect = HtmlLocator.label(t('logs.level'));
        yield* play.change(levelSelect, 'error');
        yield* play.expect(Locator.text('Mounted bear stdio backend')).toBeAbsent();
        yield* play
          .expect(Locator.text(`Connection timeout talking to remote (${t('logs.truncated')})`))
          .toExist();
        yield* play.change(levelSelect, '');

        const serverSelect = HtmlLocator.label(t('logs.server'));
        yield* play.change(serverSelect, 'bear');
        yield* play.expect(Locator.text('Mounted bear stdio backend')).toExist();
        yield* play.expect(Locator.text('Gateway listener retrying bind')).toBeAbsent();
        yield* play.change(serverSelect, '');

        const searchInput = HtmlLocator.label(t('logs.search'));
        yield* play.type(searchInput, 'LISTENER');
        yield* play.expect(Locator.text('Gateway listener retrying bind')).toExist();
        yield* play.expect(Locator.text('Mounted bear stdio backend')).toBeAbsent();

        yield* play.type(searchInput, 'does-not-exist');
        yield* play.expect(Locator.text(t('logs.noMatches'))).toExist();
        yield* play.type(searchInput, '');

        yield* play.change(serverSelect, 'bear');
        yield* play.click(HtmlLocator.role('button', { name: 'Copy log entry' }));
        yield* play.change(serverSelect, '');
        assert.strictEqual(copiedTexts.length, 1);
        assert.include(copiedTexts[0], '[INFO] [bear] Mounted bear stdio backend');
        yield* TestClock.adjust('1499 millis');
        yield* TestClock.adjust('1 millis');

        const clearButton = HtmlLocator.role('button', { name: t('logs.clear') });
        yield* play.click(clearButton);
        assert.strictEqual(clearCalls, 1);
        yield* play.expect(HtmlLocator.role('alert')).toHaveText('ClearDenied: Log ring locked');
        yield* play.expect(Locator.text('Mounted bear stdio backend')).toExist();

        clearMode = 'bridgeError';
        yield* play.click(clearButton);
        assert.strictEqual(clearCalls, 2);
        yield* play.expect(HtmlLocator.role('alert')).toHaveText(t('logs.clearFailed'));
        yield* play.expect(Locator.text('Mounted bear stdio backend')).toExist();

        clearMode = 'ok';
        yield* play.click(clearButton);
        assert.strictEqual(clearCalls, 3);
        yield* play.expect(Locator.text(t('logs.empty'))).toExist();
        yield* play.expect(HtmlLocator.role('status')).toBeAbsent();
      }).pipe(Effect.provide(env));
    },
  );
});
