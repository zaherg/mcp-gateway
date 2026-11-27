import { describe, expect, test } from 'bun:test';

import {
  CATALOG_LOCALES,
  type CatalogLocale,
  languageName,
  languageState,
  localeTag,
  messageTemplate,
  parseLanguagePreference,
  resolveLocale,
  translator,
} from '@mcp-gateway/shared/i18n';
import deDE from '@mcp-gateway/shared/locales/de_DE.json';
import enUS from '@mcp-gateway/shared/locales/en_US.json';
import frFR from '@mcp-gateway/shared/locales/fr_FR.json';
import trTR from '@mcp-gateway/shared/locales/tr_TR.json';

const CATALOGS: Record<CatalogLocale, Record<string, string>> = {
  en_US: enUS,
  fr_FR: frFR,
  de_DE: deDE,
  tr_TR: trTR,
};

const extractPlaceholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

describe('localeTag', () => {
  test('converts underscore catalog locales to BCP 47 hyphenated tags', () => {
    expect(CATALOG_LOCALES).toEqual(['en_US', 'fr_FR', 'de_DE', 'tr_TR']);
    expect(localeTag('en_US')).toBe('en-US');
    expect(localeTag('fr_FR')).toBe('fr-FR');
    expect(localeTag('de_DE')).toBe('de-DE');
    expect(localeTag('tr_TR')).toBe('tr-TR');
  });
});

describe('resolveLocale', () => {
  test('matches exact language and region tags with hyphen or underscore', () => {
    expect(resolveLocale(['de-DE'])).toBe('de_DE');
    expect(resolveLocale(['tr_TR'])).toBe('tr_TR');
    expect(resolveLocale(['fr-FR'])).toBe('fr_FR');
    expect(resolveLocale(['en_US'])).toBe('en_US');
  });

  test('handles script subtags and case normalization', () => {
    expect(resolveLocale(['fr-Latn-FR'])).toBe('fr_FR');
    expect(resolveLocale(['DE-at'])).toBe('de_DE');
  });

  test('falls back to same language when region differs or uses UN M.49 numeric region', () => {
    expect(resolveLocale(['fr-CA', 'de-DE'])).toBe('fr_FR');
    expect(resolveLocale(['en-GB'])).toBe('en_US');
    expect(resolveLocale(['fr-150'])).toBe('fr_FR');
    expect(resolveLocale(['en-001'])).toBe('en_US');
  });

  test('walks preference order and picks the first supported language', () => {
    expect(resolveLocale(['ja-JP', 'ar-SA', 'tr-CY'])).toBe('tr_TR');
  });

  test('falls back to en_US when preference list is empty or all unsupported', () => {
    expect(resolveLocale([])).toBe('en_US');
    expect(resolveLocale(['es-419', 'zh-Hans'])).toBe('en_US');
  });
});

describe('parseLanguagePreference and languageState', () => {
  test('accepts system and available locales, rejecting invalid or unavailable values', () => {
    expect(parseLanguagePreference('system', CATALOG_LOCALES)).toBe('system');
    for (const locale of CATALOG_LOCALES) {
      expect(parseLanguagePreference(locale, CATALOG_LOCALES)).toBe(locale);
    }

    expect(parseLanguagePreference(null, CATALOG_LOCALES)).toBeUndefined();
    expect(parseLanguagePreference(undefined, CATALOG_LOCALES)).toBeUndefined();
    expect(parseLanguagePreference(42, CATALOG_LOCALES)).toBeUndefined();
    expect(parseLanguagePreference({}, CATALOG_LOCALES)).toBeUndefined();
    expect(parseLanguagePreference('es_ES', CATALOG_LOCALES)).toBeUndefined();
    expect(parseLanguagePreference('de_DE', ['en_US', 'fr_FR'])).toBeUndefined();
  });

  test('languageState resolves active locale from system or explicit preference', () => {
    const available = [...CATALOG_LOCALES];
    expect(languageState('system', 'fr_FR', available)).toEqual({
      preference: 'system',
      locale: 'fr_FR',
      system: 'fr_FR',
      available,
    });
    expect(languageState('de_DE', 'fr_FR', available)).toEqual({
      preference: 'de_DE',
      locale: 'de_DE',
      system: 'fr_FR',
      available,
    });
  });
});

describe('messageTemplate, languageName, and translator', () => {
  test('messageTemplate returns raw catalog text and languageName returns non-empty native names', () => {
    expect(messageTemplate('en_US', 'common.quitApp')).toBe('Quit {app}');
    expect(languageName('en_US')).toBe('English (United States)');
    expect(languageName('fr_FR')).toBe('Français (France)');
    expect(languageName('de_DE')).toBe('Deutsch (Deutschland)');
    expect(languageName('tr_TR')).toBe('Türkçe (Türkiye)');
    for (const locale of CATALOG_LOCALES) {
      expect(languageName(locale).trim().length).toBeGreaterThan(0);
    }
  });

  test('translator substitutes string and numeric placeholders including zero', () => {
    const t = translator('en_US');
    expect(t('common.quitApp', { app: 'MCP Gateway' })).toBe('Quit MCP Gateway');
    expect(t('keys.moveMany', { count: 0 })).toBe('Move 0 keys to Keychain');
    expect(t('raw.issueAt', { message: 'Invalid token', line: 0, column: 12 })).toBe(
      'Invalid token (line 0, column 12)',
    );
  });

  test('translator preserves unsupplied placeholders literally', () => {
    const t = translator('en_US');
    expect(t('common.quitApp')).toBe('Quit {app}');
    expect(t('common.quitApp', {})).toBe('Quit {app}');
    expect(t('raw.issueAt', { message: 'Bad syntax', line: 3 })).toBe(
      'Bad syntax (line 3, column {column})',
    );
  });

  test('translator ignores inherited prototype properties (SEC-13 Object.hasOwn guard)', () => {
    const t = translator('en_US');
    const inheritedValues = Object.create({
      app: 'PrototypeApp',
      count: 99,
      message: 'Inherited',
      line: 1,
      column: 2,
      constructor: 'polluted',
      toString: 'polluted',
      valueOf: 'polluted',
    }) as Record<string, string | number>;

    expect(t('common.quitApp', inheritedValues)).toBe('Quit {app}');
    expect(t('keys.moveMany', inheritedValues)).toBe('Move {count} keys to Keychain');
    expect(t('raw.issueAt', inheritedValues)).toBe('{message} (line {line}, column {column})');

    const withOwnOverride = Object.assign(Object.create({ app: 'PrototypeApp' }), {
      app: 'OwnApp',
    }) as Record<string, string | number>;
    expect(t('common.quitApp', withOwnOverride)).toBe('Quit OwnApp');
  });
});

describe('locale catalog integrity', () => {
  const sourceKeys = Object.keys(enUS).sort();

  test('all 4 locales share the exact same key set as en_US.json', () => {
    for (const locale of CATALOG_LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual(sourceKeys);
    }
  });

  test('no locale contains empty string values', () => {
    for (const locale of CATALOG_LOCALES) {
      for (const key of sourceKeys) {
        const value = CATALOGS[locale][key];
        expect(typeof value).toBe('string');
        expect(value?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('every translated string preserves the exact placeholder set from en_US.json', () => {
    for (const locale of CATALOG_LOCALES) {
      for (const key of sourceKeys) {
        const expected = extractPlaceholders(enUS[key as keyof typeof enUS]);
        const actual = extractPlaceholders(CATALOGS[locale][key] ?? '');
        expect(actual).toEqual(expected);
      }
    }
  });
});
