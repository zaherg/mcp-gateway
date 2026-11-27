import deDE from '@mcp-gateway/shared/locales/de_DE.json';
import enUS from '@mcp-gateway/shared/locales/en_US.json';
import frFR from '@mcp-gateway/shared/locales/fr_FR.json';
import trTR from '@mcp-gateway/shared/locales/tr_TR.json';

/** Every message key. `en_US.json` is the source catalog. */
export type MessageKey = keyof typeof enUS;
type Catalog = Record<MessageKey, string>;

/** Locales with a catalog file, named `language_REGION`. Add a new locale here and in `CATALOGS`. */
// A language with no exact region match falls back to the first listed catalog in that language.
export const CATALOG_LOCALES = ['en_US', 'fr_FR', 'de_DE', 'tr_TR'] as const;
export type CatalogLocale = (typeof CATALOG_LOCALES)[number];
const DEFAULT_LOCALE: CatalogLocale = 'en_US';

// Typing every catalog as `Catalog` makes a key missing from a translation a typecheck error.
const CATALOGS: Record<CatalogLocale, Catalog> = {
  en_US: enUS,
  fr_FR: frFR,
  de_DE: deDE,
  tr_TR: trTR,
};

export type Locale = CatalogLocale;
export type LanguagePreference = 'system' | Locale;

/** The saved choice, the locale in use, the locale macOS asks for, and the locales offered. */
export interface LanguageState {
  preference: LanguagePreference;
  locale: Locale;
  system: CatalogLocale;
  available: Locale[];
}

/** The BCP 47 form (`en-US`) that HTML `lang` and `Intl` expect. */
export const localeTag = (locale: Locale) => locale.replace('_', '-');

const tagParts = (tag: string) => {
  const [language = '', ...rest] = tag.replace(/_/g, '-').split('-');
  const region = rest.find((part) => /^([A-Za-z]{2}|\d{3})$/.test(part));
  return { language: language.toLowerCase(), region: region?.toUpperCase() };
};

/**
 * Walks the OS preference list in order. Each entry takes an exact language and region match,
 * else the first catalog in the same language; the first entry that matches wins.
 */
export const resolveLocale = (tags: readonly string[]) => {
  for (const tag of tags) {
    const { language, region } = tagParts(tag);
    const exact = CATALOG_LOCALES.find((locale) => locale === `${language}_${region}`);
    if (exact) return exact;
    const sameLanguage = CATALOG_LOCALES.find((locale) => locale.split('_')[0] === language);
    if (sameLanguage) return sameLanguage;
  }
  return DEFAULT_LOCALE;
};

export const parseLanguagePreference = (
  value: unknown,
  available: readonly Locale[],
): LanguagePreference | undefined =>
  value === 'system' ? 'system' : available.find((locale) => locale === value);

export const languageState = (
  preference: LanguagePreference,
  system: CatalogLocale,
  available: Locale[],
) => ({
  preference,
  locale: preference === 'system' ? system : preference,
  system,
  available,
});

const PLACEHOLDER = /\{(\w+)\}/g;

/** The raw catalog text, for callers that substitute React elements. */
export const messageTemplate = (locale: Locale, key: MessageKey) => CATALOGS[locale][key];

/** A locale's own name, from its catalog. */
export const languageName = (locale: Locale) => messageTemplate(locale, 'language.name');

type MessageValues = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, values?: MessageValues) => string;

/** A placeholder without a value stays visible, so the omission shows in review. */
export const translator =
  (locale: Locale): Translate =>
  (key, values) =>
    messageTemplate(locale, key).replace(PLACEHOLDER, (match, name: string) => {
      const value = values && Object.hasOwn(values, name) ? values[name] : undefined;
      return value === undefined ? match : String(value);
    });
