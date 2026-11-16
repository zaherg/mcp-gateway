import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

import {
  type Locale,
  localeTag,
  type MessageKey,
  messageTemplate,
  resolveLocale,
  type Translate,
  translator,
} from '@mcp-gateway/shared/i18n';

interface I18n {
  locale: Locale;
  t: Translate;
  /** Like `t`, but substitutes React nodes. */
  rich: (key: MessageKey, values: Readonly<Record<string, ReactNode>>) => ReactNode[];
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18n | null>(null);
const TEMPLATE_PART = /(\{\w+\})/;

interface I18nProvider {
  children: ReactNode;
}

export const I18nProvider = ({ children }: I18nProvider) => {
  // Until the first snapshot names the saved choice, follow the WebView's languages.
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(navigator.languages));
  useLayoutEffect(() => {
    document.documentElement.lang = localeTag(locale);
  }, [locale]);
  const value = useMemo<I18n>(
    () => ({
      locale,
      t: translator(locale),
      rich: (key, values) =>
        messageTemplate(locale, key)
          .split(TEMPLATE_PART)
          .map((part) => {
            const name = /^\{(\w+)\}$/.exec(part)?.[1];
            if (name === undefined || !(name in values)) return part;
            // No catalog value repeats a placeholder, so its name is a stable key.
            return <Fragment key={name}>{values[name]}</Fragment>;
          }),
      setLocale,
    }),
    [locale],
  );
  return <I18nContext value={value}>{children}</I18nContext>;
};

export const useI18n = (): I18n => {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider.');
  return value;
};
