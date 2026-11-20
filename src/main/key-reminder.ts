import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParent } from '@mcp-gateway/core/config';

const REMINDER_FILE = 'key-reminder.json';

const parseRetired = (text: string): boolean => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return false;
  const { schema_version, retired } = document as Record<string, unknown>;
  return schema_version === 1 && retired === true;
};

/**
 * Remembers that the Overview reminder to move keys to Keychain is retired for good. An
 * unreadable file counts as unset, so the worst case is one more reminder.
 */
export class KeyReminderStore {
  private constructor(
    private readonly path: string,
    private retiredState: boolean,
  ) {}

  /** `existingInstall` is false on a first launch, whose new configuration needs no reminder. */
  static async open(dataDirectory: string, existingInstall: boolean): Promise<KeyReminderStore> {
    const path = join(dataDirectory, REMINDER_FILE);
    let retired = false;
    try {
      retired = parseRetired(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('The key reminder preference could not be read.');
    }
    const store = new KeyReminderStore(path, retired);
    if (!retired && !existingInstall)
      await store.retire().catch(() => console.error('The key reminder could not be retired.'));
    return store;
  }

  get retired(): boolean {
    return this.retiredState;
  }

  /** Retired for this run even if the save fails; the save failure is reported to the caller. */
  async retire(): Promise<void> {
    if (this.retiredState) return;
    this.retiredState = true;
    await ensureParent(this.path);
    // Same as writePreference in language.ts: a temporary file and rename, so a torn write
    // cannot bring a retired reminder back and a planted symlink is replaced, not followed.
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schema_version: 1, retired: true }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
