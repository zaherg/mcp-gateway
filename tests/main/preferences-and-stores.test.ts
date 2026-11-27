import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayError } from '@mcp-gateway/core/errors';
import { KeyReminderStore } from '@mcp-gateway/main/key-reminder';
import { LanguageStore } from '@mcp-gateway/main/language';
import { readPrivateJson, writePrivateJsonAtomic } from '@mcp-gateway/main/preferences-store';
import { WhatsNewStore } from '@mcp-gateway/main/whats-new';
import { CATALOG_LOCALES } from '@mcp-gateway/shared/i18n';

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-gateway-prefs-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('preferences-store', () => {
  test('readPrivateJson returns missing when file does not exist (ENOENT)', async () => {
    const dir = await makeTempDir();
    const result = await readPrivateJson(join(dir, 'absent.json'), (record) => record.flag);
    expect(result).toEqual({ status: 'missing' });
  });

  test('readPrivateJson returns ok for a valid owner-only schema_version 1 JSON file', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'pref.json');
    await writeFile(filePath, JSON.stringify({ schema_version: 1, label: 'alpha' }), {
      mode: 0o600,
    });
    await chmod(filePath, 0o600);

    const result = await readPrivateJson(filePath, (record) =>
      typeof record.label === 'string' ? record.label : undefined,
    );
    expect(result).toEqual({ status: 'ok', value: 'alpha' });
  });

  test('readPrivateJson returns invalid when target path is a symlink (O_NOFOLLOW)', async () => {
    const dir = await makeTempDir();
    const realFile = join(dir, 'real.json');
    const linkPath = join(dir, 'link.json');
    await writeFile(realFile, JSON.stringify({ schema_version: 1, ok: true }), { mode: 0o600 });
    await chmod(realFile, 0o600);
    await symlink(realFile, linkPath);

    const result = await readPrivateJson(linkPath, (record) => record.ok === true);
    expect(result).toEqual({ status: 'invalid' });
  });

  test('readPrivateJson returns invalid when file has group or other permissions', async () => {
    const dir = await makeTempDir();
    for (const mode of [0o640, 0o604, 0o644]) {
      const filePath = join(dir, `mode-${mode.toString(8)}.json`);
      await writeFile(filePath, JSON.stringify({ schema_version: 1, ok: true }), { mode: 0o600 });
      await chmod(filePath, mode);

      const result = await readPrivateJson(filePath, (record) => record.ok === true);
      expect(result).toEqual({ status: 'invalid' });
    }
  });

  test('readPrivateJson returns invalid on malformed JSON, non-object, or wrong schema_version', async () => {
    const dir = await makeTempDir();
    const cases: Array<[string, string]> = [
      ['malformed.json', '{not-json'],
      ['array.json', JSON.stringify([1, 2, 3])],
      ['null.json', 'null'],
      ['missing-schema.json', JSON.stringify({ value: 'x' })],
      ['wrong-schema.json', JSON.stringify({ schema_version: 2, value: 'x' })],
    ];
    for (const [name, content] of cases) {
      const filePath = join(dir, name);
      await writeFile(filePath, content, { mode: 0o600 });
      await chmod(filePath, 0o600);

      const result = await readPrivateJson(filePath, (record) => record.value);
      expect(result).toEqual({ status: 'invalid' });
    }
  });

  test('readPrivateJson returns invalid when validator callback returns undefined', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'invalid-payload.json');
    await writeFile(filePath, JSON.stringify({ schema_version: 1, count: 'not-a-number' }), {
      mode: 0o600,
    });
    await chmod(filePath, 0o600);

    const result = await readPrivateJson(filePath, (record) =>
      typeof record.count === 'number' ? record.count : undefined,
    );
    expect(result).toEqual({ status: 'invalid' });
  });

  test('writePrivateJsonAtomic creates parent directories with 0o700 and target file with 0o600', async () => {
    const dir = await makeTempDir();
    const nestedParent = join(dir, 'nested', 'prefs');
    const filePath = join(nestedParent, 'settings.json');

    await writePrivateJsonAtomic(filePath, { enabled: true });

    const parentStat = await stat(nestedParent);
    const fileStat = await stat(filePath);
    expect(parentStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      enabled: true,
    });
    expect(await readdir(nestedParent)).toEqual(['settings.json']);
  });

  test('writePrivateJsonAtomic refuses symlinked parent directory without leaving temp files', async () => {
    const dir = await makeTempDir();
    const realDir = join(dir, 'real-dir');
    const linkDir = join(dir, 'link-dir');
    await mkdir(realDir, { mode: 0o700 });
    await symlink(realDir, linkDir);

    let thrown: unknown;
    try {
      await writePrivateJsonAtomic(join(linkDir, 'settings.json'), { ok: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GatewayError);
    expect((thrown as GatewayError).code).toBe('UnsafeFile');
    expect(await readdir(realDir)).toEqual([]);
  });

  test('writePrivateJsonAtomic atomically replaces a symlink target without modifying its destination', async () => {
    const dir = await makeTempDir();
    const victimPath = join(dir, 'victim.txt');
    const targetLink = join(dir, 'target.json');
    await writeFile(victimPath, 'untouched-content', { mode: 0o600 });
    await symlink(victimPath, targetLink);

    await writePrivateJsonAtomic(targetLink, { replaced: true });

    const linkStat = await lstat(targetLink);
    expect(linkStat.isSymbolicLink()).toBe(false);
    expect(linkStat.isFile()).toBe(true);
    expect(linkStat.mode & 0o777).toBe(0o600);
    expect(await readFile(victimPath, 'utf8')).toBe('untouched-content');
    expect(JSON.parse(await readFile(targetLink, 'utf8'))).toEqual({
      schema_version: 1,
      replaced: true,
    });
  });

  test('writePrivateJsonAtomic cleans up temporary sibling file when rename fails', async () => {
    const dir = await makeTempDir();
    const targetDir = join(dir, 'occupied.json');
    await mkdir(targetDir, { mode: 0o700 });

    await expect(writePrivateJsonAtomic(targetDir, { ok: true })).rejects.toThrow();

    const entries = await readdir(dir);
    expect(entries).toEqual(['occupied.json']);
  });
});

describe('KeyReminderStore', () => {
  test('defaults to retired: false on existing install when key-reminder.json does not exist', async () => {
    const dir = await makeTempDir();
    const store = await KeyReminderStore.open(dir, true);

    expect(store.retired).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  test('auto-retires on fresh install (existingInstall: false) and writes 0o600 key-reminder.json', async () => {
    const dir = await makeTempDir();
    const store = await KeyReminderStore.open(dir, false);
    const filePath = join(dir, 'key-reminder.json');

    expect(store.retired).toBe(true);
    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      retired: true,
    });
  });

  test('retire() persists state with 0o600 mode, is idempotent, and survives re-open', async () => {
    const dir = await makeTempDir();
    const store = await KeyReminderStore.open(dir, true);
    expect(store.retired).toBe(false);

    await store.retire();
    expect(store.retired).toBe(true);

    const filePath = join(dir, 'key-reminder.json');
    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      retired: true,
    });

    await store.retire();

    const reopened = await KeyReminderStore.open(dir, true);
    expect(reopened.retired).toBe(true);
  });

  test('falls back safely to retired: false when key-reminder.json is corrupted or world-readable', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir1 = await makeTempDir();
      const corruptPath = join(dir1, 'key-reminder.json');
      await writeFile(corruptPath, '{corrupted', { mode: 0o600 });
      await chmod(corruptPath, 0o600);
      const store1 = await KeyReminderStore.open(dir1, true);
      expect(store1.retired).toBe(false);

      const dir2 = await makeTempDir();
      const loosePath = join(dir2, 'key-reminder.json');
      await writeFile(loosePath, JSON.stringify({ schema_version: 1, retired: true }), {
        mode: 0o600,
      });
      await chmod(loosePath, 0o644);
      const store2 = await KeyReminderStore.open(dir2, true);
      expect(store2.retired).toBe(false);

      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('retire() marks retired in memory even if save fails, while propagating error', async () => {
    const dir = await makeTempDir();
    const store = await KeyReminderStore.open(dir, true);
    await mkdir(join(dir, 'key-reminder.json'), { mode: 0o700 });

    await expect(store.retire()).rejects.toThrow();
    expect(store.retired).toBe(true);
  });

  test('open(dir, false) handles auto-retire write failure without throwing', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = await makeTempDir();
      await mkdir(join(dir, 'key-reminder.json'), { mode: 0o700 });

      const store = await KeyReminderStore.open(dir, false);
      expect(store.retired).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('WhatsNewStore', () => {
  test('on fresh install records currentVersion as seen without queuing pending release notes', async () => {
    const dir = await makeTempDir();
    const store = await WhatsNewStore.open(dir, '0.9.0', false);
    const filePath = join(dir, 'seen-version.json');

    expect(store.pending).toBeNull();
    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      version: '0.9.0',
    });
  });

  test('on existing install without seen-version.json queues installed version until dismiss()', async () => {
    const dir = await makeTempDir();
    const store = await WhatsNewStore.open(dir, '0.9.0', true);

    expect(store.pending).toBe('0.9.0');
    expect(await readdir(dir)).toEqual([]);

    await store.dismiss();
    expect(store.pending).toBeNull();
    const filePath = join(dir, 'seen-version.json');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      version: '0.9.0',
    });
  });

  test('exposes new version as pending when persisted version is older, then persists on dismiss()', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'seen-version.json');
    await writePrivateJsonAtomic(filePath, { version: '0.8.3' });

    const store = await WhatsNewStore.open(dir, '0.9.0', true);
    expect(store.pending).toBe('0.9.0');

    await store.dismiss();
    expect(store.pending).toBeNull();

    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      version: '0.9.0',
    });

    const reopened = await WhatsNewStore.open(dir, '0.9.0', true);
    expect(reopened.pending).toBeNull();
  });

  test('does not queue or write anything when installedVersion is null (dev / non-stable build)', async () => {
    const dirFresh = await makeTempDir();
    const freshStore = await WhatsNewStore.open(dirFresh, null, false);
    expect(freshStore.pending).toBeNull();
    await freshStore.dismiss();
    expect(await readdir(dirFresh)).toEqual([]);

    const dirExisting = await makeTempDir();
    const existingStore = await WhatsNewStore.open(dirExisting, null, true);
    expect(existingStore.pending).toBeNull();
    await existingStore.dismiss();
    expect(await readdir(dirExisting)).toEqual([]);
  });

  test('falls back safely when seen-version.json is corrupted or world-readable', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = await makeTempDir();
      const filePath = join(dir, 'seen-version.json');
      await writeFile(filePath, JSON.stringify({ schema_version: 1, version: '0.9.0' }), {
        mode: 0o600,
      });
      await chmod(filePath, 0o644);

      const store = await WhatsNewStore.open(dir, '0.9.0', true);
      expect(store.pending).toBe('0.9.0');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('dismiss() keeps notes dismissed for current run and logs without throwing when save fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = await makeTempDir();
      const store = await WhatsNewStore.open(dir, '0.9.0', true);
      await mkdir(join(dir, 'seen-version.json'), { mode: 0o700 });

      await store.dismiss();
      expect(store.pending).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('LanguageStore', () => {
  const available = [...CATALOG_LOCALES];

  test('defaults to system preference and resolves system locale when language.json is missing', async () => {
    const dir = await makeTempDir();
    const store = await LanguageStore.open(dir, 'en_US', available);

    expect(store.state).toEqual({
      preference: 'system',
      locale: 'en_US',
      system: 'en_US',
      available,
    });
    expect(store.translate('language.name')).toBe('English (United States)');
  });

  test('set() persists language.json with 0o600 mode, updates state and translate, and reloads', async () => {
    const dir = await makeTempDir();
    const store = await LanguageStore.open(dir, 'en_US', available);

    await store.set('fr_FR');
    expect(store.state).toEqual({
      preference: 'fr_FR',
      locale: 'fr_FR',
      system: 'en_US',
      available,
    });
    expect(store.translate('language.name')).toBe('Français (France)');

    const filePath = join(dir, 'language.json');
    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      language: 'fr_FR',
    });

    const reopened = await LanguageStore.open(dir, 'en_US', available);
    expect(reopened.state.preference).toBe('fr_FR');
    expect(reopened.state.locale).toBe('fr_FR');

    await reopened.set('system');
    expect(reopened.state.preference).toBe('system');
    expect(reopened.state.locale).toBe('en_US');
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schema_version: 1,
      language: 'system',
    });
  });

  test('falls back safely to system when language.json has an unsupported locale or unsafe permissions', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir1 = await makeTempDir();
      await writePrivateJsonAtomic(join(dir1, 'language.json'), { language: 'es_ES' });
      const store1 = await LanguageStore.open(dir1, 'de_DE', available);
      expect(store1.state.preference).toBe('system');
      expect(store1.state.locale).toBe('de_DE');
      expect(store1.translate('language.name')).toBe('Deutsch (Deutschland)');

      const dir2 = await makeTempDir();
      const loosePath = join(dir2, 'language.json');
      await writeFile(loosePath, JSON.stringify({ schema_version: 1, language: 'fr_FR' }), {
        mode: 0o600,
      });
      await chmod(loosePath, 0o644);
      const store2 = await LanguageStore.open(dir2, 'en_US', available);
      expect(store2.state.preference).toBe('system');
      expect(store2.state.locale).toBe('en_US');

      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('atomic write-before-state-update leaves current preference unchanged when save fails', async () => {
    const dir = await makeTempDir();
    const store = await LanguageStore.open(dir, 'en_US', available);
    await store.set('fr_FR');

    // Replace language.json with a directory so atomic rename fails.
    const filePath = join(dir, 'language.json');
    await rm(filePath);
    await mkdir(filePath, { mode: 0o700 });

    await expect(store.set('de_DE')).rejects.toThrow();
    expect(store.state.preference).toBe('fr_FR');
    expect(store.state.locale).toBe('fr_FR');
    expect(store.translate('language.name')).toBe('Français (France)');
  });
});
