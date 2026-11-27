import { describe, expect, test } from 'bun:test';

import * as z from 'zod/v4';

import {
  failure,
  GatewayError,
  RequestError,
  sanitizeErrorText,
  visible,
} from '@mcp-gateway/core/errors';
import { LogBuffer, redactText } from '@mcp-gateway/core/logs';
import { ownRecord } from '@mcp-gateway/core/schema';
import { createSerialQueue } from '@mcp-gateway/core/serial-queue';
import { LOG_LIMITS, type LogEntry } from '@mcp-gateway/shared/types';
import { deferred } from '../helpers/core';

const ISSUE_ID_PATTERN = /^issue-(\d+)$/;

const issueNumber = (id: string): number => {
  const match = ISSUE_ID_PATTERN.exec(id);
  if (!match) throw new Error(`Expected issue-N occurrenceId, got: ${id}`);
  return Number(match[1]);
};

const meta = { server: 'test-server', level: 'info' as const, source: 'logger' as const };

describe('src/core/errors', () => {
  test('failure creates GatewayError instances with incrementing occurrenceId values', () => {
    const first = failure('NetworkPolicy', 'Blocked host');
    const second = failure('InvalidConfig', 'Bad port');

    expect(first).toBeInstanceOf(Error);
    expect(first).toBeInstanceOf(GatewayError);
    expect(first.name).toBe('GatewayError');
    expect(first.code).toBe('NetworkPolicy');
    expect(first.message).toBe('Blocked host');
    expect(first.occurrenceId).toMatch(ISSUE_ID_PATTERN);

    expect(second.code).toBe('InvalidConfig');
    expect(issueNumber(second.occurrenceId)).toBe(issueNumber(first.occurrenceId) + 1);
  });

  test('visible preserves GatewayError fields and masks unknown errors as BackendFailure', () => {
    const gatewayError = failure('ConfigLocked', 'Config is locked.');
    expect(visible(gatewayError)).toEqual({
      code: 'ConfigLocked',
      message: 'Config is locked.',
      occurrenceId: gatewayError.occurrenceId,
    });

    const firstMasked = visible(new Error('raw internal stack detail'));
    const secondMasked = visible('unexpected string failure');
    const thirdMasked = visible(new RequestError('bad rpc'));

    for (const masked of [firstMasked, secondMasked, thirdMasked]) {
      expect(masked.code).toBe('BackendFailure');
      expect(masked.message).toBe('The operation failed. Open Logs for details.');
      expect(masked.occurrenceId).toMatch(ISSUE_ID_PATTERN);
    }
    expect(issueNumber(secondMasked.occurrenceId)).toBe(issueNumber(firstMasked.occurrenceId) + 1);
    expect(issueNumber(thirdMasked.occurrenceId)).toBe(issueNumber(secondMasked.occurrenceId) + 1);
  });

  test('sanitizeErrorText strips control chars, redacts secrets, falls back, and truncates', () => {
    expect(sanitizeErrorText('line1\x00\x07\nline2\tline3\x7f', 'fallback')).toBe(
      'line1 line2 line3',
    );

    expect(
      sanitizeErrorText('connect failed: https://user:secret@example.com/path', 'fallback'),
    ).toBe('connect failed: https://[REDACTED]@example.com/path');

    expect(
      sanitizeErrorText(
        'https://example.com/mcp?token=abc&api_key=def&apikey=123&key=456&secret=789&access_token=xyz&password=ghi#top',
        'fallback',
      ),
    ).toBe(
      'https://example.com/mcp?token=[REDACTED]&api_key=[REDACTED]&apikey=[REDACTED]&key=[REDACTED]&secret=[REDACTED]&access_token=[REDACTED]&password=[REDACTED]#top',
    );

    expect(
      sanitizeErrorText('rejected Bearer tok_12345 and Basic dXNlcjpwYXNz; retry', 'fallback'),
    ).toBe('rejected Bearer [REDACTED] and Basic [REDACTED]; retry');

    expect(sanitizeErrorText(new Error('Bearer secret_in_error'), 'fallback')).toBe(
      'Bearer [REDACTED]',
    );

    expect(sanitizeErrorText('', 'fallback')).toBe('fallback');
    expect(sanitizeErrorText('   \t\n  ', 'fallback')).toBe('fallback');
    expect(sanitizeErrorText('\x00\x1f\x7f', 'fallback')).toBe('fallback');
    expect(sanitizeErrorText(null, 'fallback')).toBe('fallback');
    expect(sanitizeErrorText(undefined, 'fallback')).toBe('fallback');
    expect(sanitizeErrorText(12345, 'fallback')).toBe('fallback');
    expect(sanitizeErrorText({ message: 'not an Error' }, 'fallback')).toBe('fallback');

    const exact = 'a'.repeat(240);
    expect(sanitizeErrorText(exact, 'fallback')).toBe(exact);

    const overDefault = 'b'.repeat(241);
    const defaultTruncated = sanitizeErrorText(overDefault, 'fallback');
    expect(defaultTruncated.length).toBe(240);
    expect(defaultTruncated.endsWith('...')).toBe(true);
    expect(defaultTruncated).toBe(`${'b'.repeat(237)}...`);

    expect(sanitizeErrorText('0123456789abcdef', 'fallback', 10)).toBe('0123456...');
  });
});

describe('src/core/schema', () => {
  test('ownRecord validates literal __proto__ keys and preserves valid own properties', () => {
    const schema = ownRecord(z.string());

    const invalidProto: unknown = JSON.parse('{"__proto__": 123}');
    expect(schema.safeParse(invalidProto).success).toBe(false);

    const validProto: unknown = JSON.parse('{"__proto__": "safe", "normal": "value"}');
    const parsed = schema.safeParse(validProto);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.hasOwn(parsed.data, '__proto__')).toBe(true);
      expect(Object.getOwnPropertyDescriptor(parsed.data, '__proto__')?.value).toBe('safe');
      expect(Object.hasOwn(parsed.data, 'normal')).toBe(true);
      expect(parsed.data.normal).toBe('value');
      expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype);
    }

    expect(schema.safeParse({ ok: 'yes', bad: 42 }).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse(['a', 'b']).success).toBe(false);
    expect(schema.safeParse('string').success).toBe(false);
  });
});

describe('src/core/serial-queue', () => {
  test('createSerialQueue runs tasks strictly in FIFO order one at a time', async () => {
    const enqueue = createSerialQueue();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const gate1 = deferred();
    const gate2 = deferred();

    const runTask = (id: number, barrier?: Promise<void>) =>
      enqueue(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${id}`);
        await barrier;
        events.push(`end:${id}`);
        active--;
        return id * 10;
      });

    const p1 = runTask(1, gate1.promise);
    const p2 = runTask(2, gate2.promise);
    const p3 = runTask(3);

    await Promise.resolve();
    expect(events).toEqual(['start:1']);
    gate2.resolve();
    gate1.resolve();

    const results = await Promise.all([p1, p2, p3]);

    expect(results).toEqual([10, 20, 30]);
    expect(maxActive).toBe(1);
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  });

  test('createSerialQueue continues executing later tasks after sync throw or async rejection', async () => {
    const enqueue = createSerialQueue();
    const order: string[] = [];

    const first = enqueue(async () => {
      order.push('first');
      throw new Error('async failure');
    });
    const second = enqueue(() => {
      order.push('second');
      throw new Error('sync failure');
    });
    const third = enqueue(() => {
      order.push('third');
      return 'recovered';
    });

    await expect(first).rejects.toThrow('async failure');
    await expect(second).rejects.toThrow('sync failure');
    await expect(third).resolves.toBe('recovered');
    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('src/core/logs', () => {
  test('redactText scrubs auth headers, custom headers, JSON fields, URL params, well-known tokens, and runtime secrets', () => {
    // Authorization headers
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactText('authorization: Basic dXNlcjpwYXNz')).toBe('authorization: Basic [REDACTED]');
    expect(redactText('Authorization: Token tok_abc123')).toBe('Authorization: Token [REDACTED]');
    expect(redactText('Authorization: Digest opaque123')).toBe('Authorization: Digest [REDACTED]');

    // API key / secret / token headers
    expect(redactText('X-API-Key: supersecretkey')).toBe('X-API-Key: [REDACTED]');
    expect(redactText('anthropic-api-key=secretvalue123')).toBe('anthropic-api-key=[REDACTED]');
    expect(redactText('my-secret: topsecretvalue')).toBe('my-secret: [REDACTED]');
    expect(redactText('custom-token=tok987654')).toBe('custom-token=[REDACTED]');

    // JSON properties
    const jsonInput = JSON.stringify({
      token: 'v1',
      authorization: 'v2',
      apiKey: 'v3',
      api_key: 'v4',
      secret: 'v5',
      password: 'v6',
      client_secret: 'v7',
      access_token: 'v8',
      refresh_token: 'v9',
      'x-api-key': 'v10',
      safe: 'kept',
    });
    expect(JSON.parse(redactText(jsonInput))).toEqual({
      token: '[REDACTED]',
      authorization: '[REDACTED]',
      apiKey: '[REDACTED]',
      api_key: '[REDACTED]',
      secret: '[REDACTED]',
      password: '[REDACTED]',
      client_secret: '[REDACTED]',
      access_token: '[REDACTED]',
      refresh_token: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      safe: 'kept',
    });

    // URL query parameters
    expect(
      redactText(
        'GET https://api.example.com?token=t1&api_key=k1&apikey=k2&key=k3&secret=s1&access_token=a1&password=p1&ok=1',
      ),
    ).toBe(
      'GET https://api.example.com?token=[REDACTED]&api_key=[REDACTED]&apikey=[REDACTED]&key=[REDACTED]&secret=[REDACTED]&access_token=[REDACTED]&password=[REDACTED]&ok=1',
    );

    // Standalone well-known token prefixes
    expect(
      redactText(
        'keys: sk-1234567890abcdef ghp_1234567890abcdefghij github_pat_1234567890abcdefghij xoxb-1234567890abcdef',
      ),
    ).toBe('keys: [REDACTED] [REDACTED] [REDACTED] [REDACTED]');

    // Runtime secrets: longest-first matching for overlaps, ignore < 8 chars
    expect(
      redactText('prefix=my-secret-extended short=tiny123', [
        'my-secret',
        'my-secret-extended',
        'tiny123',
      ]),
    ).toBe('prefix=[REDACTED] short=tiny123');
  });

  test('LogBuffer formats primitives, symbol keys, circular refs, deep objects, >100 keys, getters, and throwing proxies safely', () => {
    const buffer = new LogBuffer();
    buffer.registerSecrets(['runtime-secret-value', 'short7']);

    let getterInvoked = 0;
    let toJsonInvoked = 0;
    let toStringInvoked = 0;

    const circular: Record<string, unknown> = { label: 'root' };
    circular.self = circular;

    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 10; i++) {
      deep = { nested: deep };
    }

    const wide: Record<string, number> = {};
    for (let i = 0; i < 105; i++) {
      wide[`k${i}`] = i;
    }

    const withAccessor: Record<string, unknown> = {
      visible: 'ok',
      toJSON() {
        toJsonInvoked++;
        return 'custom-json';
      },
      toString() {
        toStringInvoked++;
        return 'custom-string';
      },
    };
    Object.defineProperty(withAccessor, 'trap', {
      enumerable: true,
      get() {
        getterInvoked++;
        return 'should-never-run';
      },
    });

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('proxy trap boom');
        },
      },
    );

    const symbolKeyed = { [Symbol('tag')]: 'secret-free' };

    buffer.append(meta, [
      'str',
      42,
      true,
      null,
      undefined,
      99n,
      () => {},
      Symbol('s'),
      'runtime-secret-value',
      'short7',
    ]);
    buffer.append(meta, [circular]);
    buffer.append(meta, [deep]);
    buffer.append(meta, [wide]);
    buffer.append(meta, [withAccessor]);
    buffer.append(meta, [throwingProxy]);
    buffer.append(meta, [symbolKeyed]);

    const page = buffer.read({ after: 0 });
    expect(page.entries).toHaveLength(7);

    const [
      primitives,
      circEntry,
      deepEntry,
      wideEntry,
      accessorEntry,
      proxyEntry,
      symbolKeyedEntry,
    ] = page.entries;
    expect(primitives?.text).toBe(
      'str 42 true null undefined 99 [function] [symbol] [REDACTED] short7',
    );
    expect(circEntry?.text).toContain('[circular]');
    expect(deepEntry?.text).toContain('[depth limit]');
    expect(wideEntry?.text).toContain('[property limit]');
    expect(wideEntry?.text).not.toContain('k100:');
    expect(accessorEntry?.text).toContain('trap: [accessor]');
    expect(accessorEntry?.text).not.toContain('should-never-run');
    expect(getterInvoked).toBe(0);
    expect(toJsonInvoked).toBe(0);
    expect(toStringInvoked).toBe(0);
    expect(proxyEntry?.text).toContain('[unreadable object]');
    expect(symbolKeyedEntry?.text).toContain('[symbol]: secret-free');
  });

  test('LogBuffer truncates entries exceeding LOG_LIMITS.entryBytes', () => {
    const buffer = new LogBuffer();

    buffer.append(meta, ['short message']);
    buffer.append(meta, ['word '.repeat(Math.ceil((LOG_LIMITS.entryBytes + 4096) / 5))]);
    // Escaped quotes double serialized length even when raw bytes are under entryBytes.
    buffer.append(meta, ['"'.repeat(Math.floor(LOG_LIMITS.entryBytes * 0.75))]);

    const page = buffer.read({ after: 0 });
    expect(page.entries).toHaveLength(3);

    const [shortEntry, rawOversized, escapedOversized] = page.entries;
    expect(shortEntry?.truncated).toBe(false);
    expect(rawOversized?.truncated).toBe(true);
    expect(rawOversized?.text.endsWith('\n[entry truncated]')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(rawOversized))).toBeLessThanOrEqual(
      LOG_LIMITS.entryBytes,
    );

    expect(escapedOversized?.truncated).toBe(true);
    expect(escapedOversized?.text.endsWith('\n[entry truncated]')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(escapedOversized))).toBeLessThanOrEqual(
      LOG_LIMITS.entryBytes,
    );
  });

  test('LogBuffer evicts oldest entries when exceeding LOG_LIMITS.entries or LOG_LIMITS.bytes', () => {
    // Count-based eviction (> LOG_LIMITS.entries)
    const countBuffer = new LogBuffer();
    const totalCount = LOG_LIMITS.entries + 25;
    for (let i = 1; i <= totalCount; i++) {
      countBuffer.append(meta, [`msg-${i}`]);
    }

    const drained: LogEntry[] = [];
    let after = 0;
    let firstGap: boolean | undefined;
    while (true) {
      const page = countBuffer.read({ after });
      if (firstGap === undefined) firstGap = page.gap;
      drained.push(...page.entries);
      after = page.cursor;
      if (!page.hasMore) break;
    }

    expect(firstGap).toBe(true);
    expect(drained).toHaveLength(LOG_LIMITS.entries);
    expect(drained[0]?.id).toBe(26);
    expect(drained[0]?.text).toBe('msg-26');
    expect(drained.at(-1)?.id).toBe(totalCount);

    // Byte-based eviction (> LOG_LIMITS.bytes while entry count < LOG_LIMITS.entries)
    const byteBuffer = new LogBuffer();
    const chunk = 'word '.repeat(6_000); // 30,000 bytes
    const appendCount = Math.ceil(LOG_LIMITS.bytes / 30_000) + 10;
    expect(appendCount).toBeLessThan(LOG_LIMITS.entries);

    for (let i = 1; i <= appendCount; i++) {
      byteBuffer.append(meta, [`${i} ${chunk}`]);
    }

    const firstBytePage = byteBuffer.read({ after: 0 });
    expect(firstBytePage.gap).toBe(true);
    expect(firstBytePage.entries[0]?.id).toBeGreaterThan(1);
  });

  test('LogBuffer read paginates by entry count and batchBytes cap, reports gap on stale or future cursors, and clear increments generation', () => {
    const buffer = new LogBuffer();
    const total = LOG_LIMITS.batchEntries + 15;
    for (let i = 1; i <= total; i++) {
      buffer.append(meta, [`entry-${i}`]);
    }

    const page1 = buffer.read({ after: 0 });
    expect(page1.entries).toHaveLength(LOG_LIMITS.batchEntries);
    expect(page1.cursor).toBe(LOG_LIMITS.batchEntries);
    expect(page1.hasMore).toBe(true);
    expect(page1.gap).toBe(false);
    expect(page1.generation).toBe(0);

    const page2 = buffer.read({ after: page1.cursor });
    expect(page2.entries).toHaveLength(15);
    expect(page2.cursor).toBe(total);
    expect(page2.hasMore).toBe(false);
    expect(page2.gap).toBe(false);
    expect(page2.generation).toBe(0);

    // Cursor ahead of sequence triggers gap and resets to oldest retained entry.
    const futurePage = buffer.read({ after: total + 100 });
    expect(futurePage.gap).toBe(true);
    expect(futurePage.entries[0]?.id).toBe(1);

    // clear() empties entries, increments generation, and preserves sequence progression.
    const cleared = buffer.clear();
    expect(cleared).toEqual({
      entries: [],
      cursor: total,
      generation: 1,
      gap: false,
      hasMore: false,
    });

    buffer.append(meta, ['after-clear']);
    const afterClear = buffer.read({ after: cleared.cursor });
    expect(afterClear.generation).toBe(1);
    expect(afterClear.gap).toBe(false);
    expect(afterClear.hasMore).toBe(false);
    expect(afterClear.cursor).toBe(total + 1);
    expect(afterClear.entries).toHaveLength(1);
    expect(afterClear.entries[0]?.id).toBe(total + 1);
    expect(afterClear.entries[0]?.text).toBe('after-clear');

    // Byte-batch limit (< LOG_LIMITS.batchEntries, total > LOG_LIMITS.batchBytes = 256 KiB)
    const byteBatchBuffer = new LogBuffer();
    const payload25KiB = 'word '.repeat(5 * 1024); // ~25 KiB with word boundaries (avoids expensive 25 KiB single-token regex backtracking)
    for (let i = 1; i <= 12; i++) {
      byteBatchBuffer.append(meta, [`${i} ${payload25KiB}`]);
    }

    const bytePage1 = byteBatchBuffer.read({ after: 0 });
    expect(bytePage1.entries.length).toBeGreaterThan(0);
    expect(bytePage1.entries.length).toBeLessThan(12);
    expect(bytePage1.hasMore).toBe(true);
    expect(bytePage1.gap).toBe(false);

    const bytePage2 = byteBatchBuffer.read({ after: bytePage1.cursor });
    expect(bytePage1.entries.length + bytePage2.entries.length).toBe(12);
    expect(bytePage2.hasMore).toBe(false);
    expect(bytePage2.cursor).toBe(12);
  });
});
