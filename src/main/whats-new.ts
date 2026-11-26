import { join } from 'node:path';

import { readPrivateJson, writePrivateJsonAtomic } from '@mcp-gateway/main/preferences-store';

const SEEN_FILE = 'seen-version.json';

/**
 * Remembers the version whose release notes the user has dismissed. The notes are a
 * convenience, so an unreadable file shows them again and a failed save is only reported.
 */
export class WhatsNewStore {
  private constructor(
    private readonly path: string,
    private readonly installedVersion: string | null,
    private seen: string | undefined,
  ) {}

  /** `existingInstall` tells an update from a version without this file apart from a first launch. */
  static async open(
    dataDirectory: string,
    installedVersion: string | null,
    existingInstall: boolean,
  ): Promise<WhatsNewStore> {
    const path = join(dataDirectory, SEEN_FILE);
    const result = await readPrivateJson(path, (record) =>
      typeof record.version === 'string' ? record.version : undefined,
    );
    if (result.status === 'invalid')
      console.error('The seen release notes version could not be read.');
    const seen = result.status === 'ok' ? result.value : undefined;
    const store = new WhatsNewStore(path, installedVersion, seen);
    // A first launch has nothing new to announce.
    if (seen === undefined && !existingInstall) await store.dismiss();
    return store;
  }

  /** The installed version when its release notes have not been dismissed yet. */
  get pending(): string | null {
    return this.installedVersion !== null && this.seen !== this.installedVersion
      ? this.installedVersion
      : null;
  }

  /** Marks the installed version as seen; the notes stay dismissed for this run even if the save fails. */
  async dismiss(): Promise<void> {
    if (this.installedVersion === null || this.seen === this.installedVersion) return;
    this.seen = this.installedVersion;
    try {
      await writePrivateJsonAtomic(this.path, { version: this.installedVersion });
    } catch (error) {
      console.error(
        `The seen release notes version could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
