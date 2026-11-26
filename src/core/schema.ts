import * as z from 'zod/v4';

import { isRecord } from '@mcp-gateway/shared/config-document';

/** `NaN` and `Infinity` must reach the later port check, as with the previous schema. */
export const anyNumber = z.custom<number>((value) => typeof value === 'number');

/**
 * Validates and rebuilds a string-keyed record one own entry at a time in a single pass.
 * `z.record` skips a `__proto__` key without validating it, so an unsafe value
 * would otherwise be accepted and then silently dropped.
 */
export const ownRecord = <Item extends z.ZodType>(item: Item) =>
  z
    .custom<Record<string, unknown>>((value) => isRecord(value))
    .transform((value, ctx) => {
      const entries: [string, z.output<Item>][] = [];
      for (const [key, entry] of Object.entries(value)) {
        const parsed = item.safeParse(entry);
        if (!parsed.success) {
          ctx.addIssue({ code: 'custom' });
          return z.NEVER;
        }
        entries.push([key, parsed.data]);
      }
      // Object.fromEntries defines own properties, so `__proto__` stays data.
      return Object.fromEntries(entries);
    });
