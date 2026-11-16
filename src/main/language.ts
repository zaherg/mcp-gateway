import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParent } from '@mcp-gateway/core/config';
import {
  type CatalogLocale,
  type LanguagePreference,
  type LanguageState,
  type Locale,
  languageState,
  parseLanguagePreference,
  type Translate,
  translator,
} from '@mcp-gateway/shared/i18n';

const LANGUAGE_FILE = 'language.json';

const invalidPreference = (): 'system' => {
  console.error('The language preference is invalid or unsafe; the system language is used.');
  return 'system';
};

// Same safety rules as updates.json: an owner-only regular file, never a symlink.
const readPreference = async (
  path: string,
  available: readonly Locale[],
): Promise<LanguagePreference> => {
  let text: string;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      return invalidPreference();
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'system';
    return invalidPreference();
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return invalidPreference();
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document))
    return invalidPreference();
  const { schema_version, language } = document as Record<string, unknown>;
  const preference =
    schema_version === 1 ? parseLanguagePreference(language, available) : undefined;
  return preference ?? invalidPreference();
};

// Mirrors writePreference in app-updater.ts: renaming a temporary file replaces a planted symlink
// instead of writing through it, and a failed write never leaves a partial file.
const writePreference = async (path: string, preference: LanguagePreference): Promise<void> => {
  await ensureParent(path);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schema_version: 1, language: preference }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

/** The interface language. An unusable file falls back to the system language. */
export class LanguageStore {
  private constructor(
    private readonly path: string,
    private readonly system: CatalogLocale,
    private readonly available: Locale[],
    private preference: LanguagePreference,
  ) {}

  static async open(
    dataDirectory: string,
    system: CatalogLocale,
    available: Locale[],
  ): Promise<LanguageStore> {
    const path = join(dataDirectory, LANGUAGE_FILE);
    return new LanguageStore(path, system, available, await readPreference(path, available));
  }

  get state(): LanguageState {
    return languageState(this.preference, this.system, this.available);
  }

  get translate(): Translate {
    return translator(this.state.locale);
  }

  /** Saves first, so a failed save leaves the language in use unchanged. */
  async set(preference: LanguagePreference): Promise<void> {
    await writePreference(this.path, preference);
    this.preference = preference;
  }
}
