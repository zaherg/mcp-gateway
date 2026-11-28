import type { View } from '@effect/ui';

import { type Locale, type MessageKey, messageTemplate } from '@mcp-gateway/shared/i18n';

const TEMPLATE_PART = /(\{\w+\})/;

/** Like `translator(locale)`, but substitutes Effect UI nodes for `{placeholder}` slots. */
export const richMessage = <M, R = never>(
  locale: Locale,
  key: MessageKey,
  values: Readonly<Record<string, View.Content<M, R> | string>>,
): ReadonlyArray<View.Content<M, R> | string> =>
  messageTemplate(locale, key)
    .split(TEMPLATE_PART)
    .map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (name === undefined || !(name in values)) return part;
      return values[name];
    });
