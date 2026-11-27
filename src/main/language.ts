import { join } from 'node:path';

import { readPrivateJson, writePrivateJsonAtomic } from '@mcp-gateway/main/preferences-store';
import {
  type CatalogLocale,
  type LanguagePreference,
  type Locale,
  languageState,
  parseLanguagePreference,
  translator,
} from '@mcp-gateway/shared/i18n';

const LANGUAGE_FILE = 'language.json';

const invalidPreference = (): 'system' => {
  console.error('The language preference is invalid or unsafe; the system language is used.');
  return 'system';
};

// Same safety rules as updates.json: an owner-only regular file, never a symlink.
const readPreference = async (path: string, available: readonly Locale[]) => {
  const result = await readPrivateJson(path, (record) =>
    parseLanguagePreference(record.language, available),
  );
  if (result.status === 'missing') return 'system';
  if (result.status === 'invalid') return invalidPreference();
  return result.value;
};

const writePreference = async (path: string, preference: LanguagePreference) => {
  await writePrivateJsonAtomic(path, { language: preference });
};

/** The interface language. An unusable file falls back to the system language. */
export class LanguageStore {
  private constructor(
    private readonly path: string,
    private readonly system: CatalogLocale,
    private readonly available: Locale[],
    private preference: LanguagePreference,
  ) {}

  static async open(dataDirectory: string, system: CatalogLocale, available: Locale[]) {
    const path = join(dataDirectory, LANGUAGE_FILE);
    return new LanguageStore(path, system, available, await readPreference(path, available));
  }

  get state() {
    return languageState(this.preference, this.system, this.available);
  }

  get translate() {
    return translator(this.state.locale);
  }

  /** Saves first, so a failed save leaves the language in use unchanged. */
  async set(preference: LanguagePreference) {
    await writePreference(this.path, preference);
    this.preference = preference;
  }
}
