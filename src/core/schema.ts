import * as z from 'zod/v4';

import { isRecord } from '@mcp-gateway/shared/config-document';

/** `NaN` and `Infinity` must reach the later port check, as with the previous schema. */
export const anyNumber = z.custom<number>((value) => typeof value === 'number');

/**
 * Validates and rebuilds a string-keyed record one own entry at a time.
 * `z.record` skips a `__proto__` key without validating it, so an unsafe value
 * would otherwise be accepted and then silently dropped.
 */
export const ownRecord = <Item extends z.ZodType>(item: Item) =>
  z
    .custom<Record<string, unknown>>((value) => {
      if (!isRecord(value)) return false;
      return Object.entries(value).every(([, entry]) => item.safeParse(entry).success);
    })
    .transform((value) => {
      const entries: [string, z.output<Item>][] = Object.entries(value).map(([key, entry]) => [
        key,
        item.parse(entry),
      ]);
      // Object.fromEntries defines own properties, so `__proto__` stays data.
      return Object.fromEntries(entries);
    });
