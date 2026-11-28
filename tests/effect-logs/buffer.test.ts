import { assert, describe, it } from '@effect/vitest';

import {
  applyLogPage,
  availableLogServers,
  EMPTY_LOG_BUFFER,
  filterLogEntries,
  formatLogEntryForCopy,
} from '@mcp-gateway/mainview/effect-logs/buffer';
import { LOG_LIMITS, type LogEntry } from '@mcp-gateway/shared/types';

const makeEntry = (id: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  id,
  time: `2026-11-28T10:00:${String(id % 60).padStart(2, '0')}Z`,
  server: id % 2 === 0 ? 'bear' : null,
  level: 'info',
  source: 'controller',
  text: `Message ${id}`,
  truncated: false,
  ...overrides,
});

describe('effect-logs buffer helpers', () => {
  it('appends pages, resets on generation change, and preserves gap once set', () => {
    const first = applyLogPage(EMPTY_LOG_BUFFER, {
      entries: [makeEntry(1), makeEntry(2)],
      cursor: 2,
      generation: 1,
      gap: false,
      hasMore: false,
    });
    assert.strictEqual(first.entries.length, 2);
    assert.strictEqual(first.cursor, 2);
    assert.strictEqual(first.gap, false);

    const second = applyLogPage(first, {
      entries: [makeEntry(3)],
      cursor: 3,
      generation: 1,
      gap: true,
      hasMore: false,
    });
    assert.deepStrictEqual(
      second.entries.map((entry) => entry.id),
      [1, 2, 3],
    );
    assert.strictEqual(second.gap, true);

    const reset = applyLogPage(second, {
      entries: [makeEntry(10)],
      cursor: 10,
      generation: 2,
      gap: false,
      hasMore: false,
    });
    assert.deepStrictEqual(
      reset.entries.map((entry) => entry.id),
      [10],
    );
    assert.strictEqual(reset.bufferGeneration, 2);
    assert.strictEqual(reset.gap, true);
  });

  it('caps retained entries at LOG_LIMITS.entries and marks gap', () => {
    const batch = Array.from({ length: LOG_LIMITS.entries + 25 }, (_, index) =>
      makeEntry(index + 1),
    );
    const next = applyLogPage(EMPTY_LOG_BUFFER, {
      entries: batch,
      cursor: batch.length,
      generation: 1,
      gap: false,
      hasMore: false,
    });
    assert.strictEqual(next.entries.length, LOG_LIMITS.entries);
    assert.strictEqual(next.entries[0]?.id, 26);
    assert.strictEqual(next.entries.at(-1)?.id, LOG_LIMITS.entries + 25);
    assert.strictEqual(next.gap, true);
  });

  it('caps retained entries at LOG_LIMITS.bytes and marks gap', () => {
    const chunk = 'x'.repeat(25_000);
    const count = Math.ceil(LOG_LIMITS.bytes / 25_000) + 10;
    const batch = Array.from({ length: count }, (_, index) =>
      makeEntry(index + 1, { text: chunk }),
    );
    const next = applyLogPage(EMPTY_LOG_BUFFER, {
      entries: batch,
      cursor: count,
      generation: 1,
      gap: false,
      hasMore: false,
    });
    assert.isBelow(next.entries.length, count);
    assert.strictEqual(next.entries.at(-1)?.id, count);
    assert.strictEqual(next.gap, true);
  });

  it('filters entries by level, server, and case-insensitive text', () => {
    const entries: LogEntry[] = [
      makeEntry(1, { level: 'info', server: 'bear', text: 'Mounted bear stdio backend' }),
      makeEntry(2, { level: 'error', server: 'remote', text: 'Connection timeout' }),
      makeEntry(3, { level: 'warn', server: null, text: 'Gateway LISTENER retrying bind' }),
    ];

    assert.strictEqual(
      filterLogEntries(entries, { level: 'error', server: '', text: '' }).length,
      1,
    );
    assert.strictEqual(
      filterLogEntries(entries, { level: '', server: 'bear', text: '' }).length,
      1,
    );
    assert.deepStrictEqual(
      filterLogEntries(entries, { level: '', server: '', text: 'listener' }).map((e) => e.id),
      [3],
    );
    assert.deepStrictEqual(availableLogServers(['zebra', 'bear'], entries), [
      'bear',
      'remote',
      'zebra',
    ]);
    assert.strictEqual(
      formatLogEntryForCopy(entries[2], 'Gateway'),
      `${entries[2].time} [WARN] [Gateway] Gateway LISTENER retrying bind`,
    );
  });
});
