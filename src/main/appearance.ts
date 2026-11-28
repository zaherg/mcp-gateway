import { join } from 'node:path';

import { readPrivateJson, writePrivateJsonAtomic } from '@mcp-gateway/main/preferences-store';
import { type AppearancePreference, parseAppearancePreference } from '@mcp-gateway/shared/rpc';

const APPEARANCE_FILE = 'appearance.json';

const invalidPreference = (): 'system' => {
  console.error('The appearance preference is invalid or unsafe; the system appearance is used.');
  return 'system';
};

// Same safety rules as language.json and updates.json: an owner-only regular file, never a symlink.
const readPreference = async (path: string) => {
  const result = await readPrivateJson(path, (record) =>
    parseAppearancePreference(record.appearance),
  );
  if (result.status === 'missing') return 'system';
  if (result.status === 'invalid') return invalidPreference();
  return result.value;
};

const writePreference = async (path: string, preference: AppearancePreference) => {
  await writePrivateJsonAtomic(path, { appearance: preference });
};

/** The window appearance. An unusable file falls back to the system appearance. */
export class AppearanceStore {
  private constructor(
    private readonly path: string,
    private value: AppearancePreference,
  ) {}

  static async open(dataDirectory: string) {
    const path = join(dataDirectory, APPEARANCE_FILE);
    return new AppearanceStore(path, await readPreference(path));
  }

  get preference() {
    return this.value;
  }

  /** Saves first, so a failed save leaves the appearance in use unchanged. */
  async set(preference: AppearancePreference) {
    await writePreference(this.path, preference);
    this.value = preference;
  }
}
