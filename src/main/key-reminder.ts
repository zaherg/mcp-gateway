import { join } from 'node:path';

import { readPrivateJson, writePrivateJsonAtomic } from '@mcp-gateway/main/preferences-store';

const REMINDER_FILE = 'key-reminder.json';

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
  static async open(dataDirectory: string, existingInstall: boolean) {
    const path = join(dataDirectory, REMINDER_FILE);
    const result = await readPrivateJson(path, (record) =>
      record.retired === true ? true : undefined,
    );
    if (result.status === 'invalid')
      console.error('The key reminder preference could not be read.');
    const retired = result.status === 'ok' ? result.value : false;
    const store = new KeyReminderStore(path, retired);
    if (!retired && !existingInstall)
      await store.retire().catch(() => console.error('The key reminder could not be retired.'));
    return store;
  }

  get retired() {
    return this.retiredState;
  }

  /** Retired for this run even if the save fails; the save failure is reported to the caller. */
  async retire() {
    if (this.retiredState) return;
    this.retiredState = true;
    await writePrivateJsonAtomic(this.path, { retired: true });
  }
}
