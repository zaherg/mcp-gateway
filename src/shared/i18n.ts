import enUS from '@mcp-gateway/shared/locales/en_US.json';

/** Every message key. `en_US.json` is the source catalog. */
export type MessageKey = keyof typeof enUS;
type Catalog = Record<MessageKey, string>;

/** Locales with a catalog file, named `language_REGION`. Add a new locale here and in `CATALOGS`. */
export const CATALOG_LOCALES = ['en_US'] as const;
export type CatalogLocale = (typeof CATALOG_LOCALES)[number];
export const DEFAULT_LOCALE: CatalogLocale = 'en_US';

// Typing every catalog as `Catalog` makes a key missing from a translation a typecheck error.
const CATALOGS: Record<CatalogLocale, Catalog> = { en_US: enUS };

/** Development-only locale generated from `en_US`; text that bypasses the catalog stands out. */
export const PSEUDO_LOCALE = 'en_XA';
export type Locale = CatalogLocale | typeof PSEUDO_LOCALE;
export type LanguagePreference = 'system' | Locale;

/** The saved choice, the locale in use, the locale macOS asks for, and the locales offered. */
export interface LanguageState {
  preference: LanguagePreference;
  locale: Locale;
  system: CatalogLocale;
  available: Locale[];
}

export const availableLocales = (development: boolean): Locale[] =>
  development ? [...CATALOG_LOCALES, PSEUDO_LOCALE] : [...CATALOG_LOCALES];

/** The BCP 47 form (`en-US`) that HTML `lang` and `Intl` expect. */
export const localeTag = (locale: Locale): string => locale.replace('_', '-');

const tagParts = (tag: string): { language: string; region: string | undefined } => {
  const [language = '', ...rest] = tag.replace(/_/g, '-').split('-');
  const region = rest.find((part) => /^([A-Za-z]{2}|\d{3})$/.test(part));
  return { language: language.toLowerCase(), region: region?.toUpperCase() };
};

/**
 * Walks the OS preference list in order. Each entry takes an exact language and region match,
 * else the first catalog in the same language; the first entry that matches wins.
 */
export const resolveLocale = (tags: readonly string[]): CatalogLocale => {
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
): LanguageState => ({
  preference,
  locale: preference === 'system' ? system : preference,
  system,
  available,
});

const PLACEHOLDER = /\{(\w+)\}/g;
const TEMPLATE_PARTS = /(\{\w+\})/;
const ACCENTED: Readonly<Record<string, string>> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  y: 'ý',
  n: 'ñ',
  c: 'ç',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
  Y: 'Ý',
  N: 'Ñ',
  C: 'Ç',
};

// Placeholders stay intact; only the text around them is accented, and the whole is bracketed.
const pseudoTemplate = (template: string): string =>
  `[${template
    .split(TEMPLATE_PARTS)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/[aeiouyncAEIOUYNC]/g, (letter) => ACCENTED[letter]),
    )
    .join('')}]`;

/** The raw catalog text, for callers that substitute React elements. */
export const messageTemplate = (locale: Locale, key: MessageKey): string =>
  locale === PSEUDO_LOCALE ? pseudoTemplate(CATALOGS[DEFAULT_LOCALE][key]) : CATALOGS[locale][key];

/** A locale's own name, from its catalog; the pseudo-locale has a fixed developer name. */
export const languageName = (locale: Locale): string =>
  locale === PSEUDO_LOCALE ? 'Pseudo: accented (en_XA)' : messageTemplate(locale, 'language.name');

export type MessageValues = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, values?: MessageValues) => string;

/** A placeholder without a value stays visible, so the omission shows in review. */
export const translator =
  (locale: Locale): Translate =>
  (key, values) =>
    messageTemplate(locale, key).replace(PLACEHOLDER, (match, name: string) => {
      const value = values?.[name];
      return value === undefined ? match : String(value);
    });
