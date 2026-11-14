import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParent } from '@mcp-gateway/core/config';

const SEEN_FILE = 'seen-version.json';

const parseSeen = (text: string): string | undefined => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return;
  const { schema_version, version } = document as Record<string, unknown>;
  return schema_version === 1 && typeof version === 'string' ? version : undefined;
};

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
    let seen: string | undefined;
    try {
      seen = parseSeen(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('The seen release notes version could not be read.');
    }
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
      await ensureParent(this.path);
      // shortcut: not atomic; a torn file reads as invalid and only shows the notes once more.
      await writeFile(
        this.path,
        JSON.stringify({ schema_version: 1, version: this.installedVersion }),
        { mode: 0o600 },
      );
    } catch (error) {
      console.error(
        `The seen release notes version could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
