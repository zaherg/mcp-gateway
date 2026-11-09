import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParent } from '@mcp-gateway/core/config';
import { RequestError } from '@mcp-gateway/core/errors';
import type { QuitCoordinator } from '@mcp-gateway/main/lifecycle';
import type { QuitStatus, UpdateStatus } from '@mcp-gateway/shared/rpc';
import { Updater, type UpdateStatusEntry } from 'electrobun/main';

const PREFERENCE_FILE = 'updates.json';
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 60 * 60 * 1_000;
const PREFERENCE_ERROR =
  'Update preferences are invalid or unsafe. Background updates are disabled.';

export interface UpdateRuntime {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  setAutomatic(enabled: boolean): Promise<UpdateStatus>;
  restart(): Promise<QuitStatus>;
  start(): Promise<UpdateStatus>;
  stop(): void;
  subscribe(listener: (status: UpdateStatus) => void): () => void;
}

export const unsupportedUpdateStatus = (): UpdateStatus => {
  return {
    supported: false,
    automaticUpdates: false,
    installedVersion: null,
    availableVersion: null,
    phase: 'idle',
    error: null,
    checkedAt: null,
  };
};

export const resolveUpdateSupport = async (): Promise<{
  supported: boolean;
  installedVersion: string | null;
}> => {
  const info = await Updater.getLocalInfo();
  const installedVersion = STABLE_VERSION.test(info.version) ? info.version : null;
  return {
    supported: info.channel === 'stable' && installedVersion !== null && info.baseUrl.length > 0,
    installedVersion,
  };
};

const isHigherStableVersion = (candidate: string, installed: string | null): boolean => {
  if (!installed || !STABLE_VERSION.test(candidate) || !STABLE_VERSION.test(installed))
    return false;
  try {
    return Bun.semver.order(candidate, installed) === 1;
  } catch {
    return false;
  }
};

interface Preference {
  automaticUpdates: boolean;
  error: string | null;
}

const invalidPreference = (): Preference => ({ automaticUpdates: false, error: PREFERENCE_ERROR });

const readPreference = async (dataDirectory: string): Promise<Preference> => {
  const path = join(dataDirectory, PREFERENCE_FILE);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      return invalidPreference();
    const document = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      return invalidPreference();
    const record = document as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== 'automaticUpdates' ||
      keys[1] !== 'schema_version' ||
      record.schema_version !== 1 ||
      typeof record.automaticUpdates !== 'boolean'
    )
      return invalidPreference();
    return { automaticUpdates: record.automaticUpdates, error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { automaticUpdates: true, error: null };
    return invalidPreference();
  }
};

const writePreference = async (dataDirectory: string, automaticUpdates: boolean): Promise<void> => {
  const path = join(dataDirectory, PREFERENCE_FILE);
  await ensureParent(path);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schema_version: 1, automaticUpdates }));
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

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'The update operation failed.';

export class AppUpdater implements UpdateRuntime {
  private value: UpdateStatus;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private started = false;
  private stopped = false;
  private restartApproved = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private lastCheckAt = 0;

  constructor(
    private readonly options: {
      dataDirectory: string;
      supported: boolean;
      installedVersion: string | null;
      quit: QuitCoordinator;
    },
  ) {
    this.value = {
      supported: options.supported,
      automaticUpdates: false,
      installedVersion: options.installedVersion,
      availableVersion: null,
      phase: 'idle',
      error: null,
      checkedAt: null,
    };
  }

  status(): UpdateStatus {
    return { ...this.value };
  }

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<UpdateStatus> {
    if (!this.options.supported || this.started || this.stopped) return this.status();
    this.started = true;
    const preference = await readPreference(this.options.dataDirectory);
    this.set({ automaticUpdates: preference.automaticUpdates });
    this.seedFromSdk();
    if (preference.error)
      this.set({
        error: preference.error,
        phase: this.value.phase === 'idle' ? 'error' : this.value.phase,
      });
    Updater.onStatusChange((entry) => this.handleSdkStatus(entry));
    this.scheduleChecks();
    this.publish();
    return this.status();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    Updater.onStatusChange(null);
    this.listeners.clear();
  }

  async check(): Promise<UpdateStatus> {
    this.assertAvailable();
    if (this.value.phase === 'restarting')
      throw new RequestError('An update restart is already in progress.');
    if (this.value.phase === 'downloading' || this.value.phase === 'ready') return this.status();
    return this.performCheck();
  }

  async download(): Promise<UpdateStatus> {
    this.assertAvailable();
    if (this.value.phase === 'restarting')
      throw new RequestError('An update restart is already in progress.');
    if (this.value.phase === 'checking')
      throw new RequestError('An update check is already in progress.');
    if (this.value.phase === 'downloading') return this.status();
    if (this.value.phase === 'ready') return this.status();
    if (
      !this.value.availableVersion ||
      !isHigherStableVersion(this.value.availableVersion, this.options.installedVersion)
    )
      throw new RequestError('No eligible update is available to download.');
    // The download can outlive the window's request limit; its phase is polled.
    void this.performDownload().catch((error: unknown) =>
      this.update({ phase: 'error', error: errorMessage(error) }),
    );
    return this.status();
  }

  async setAutomatic(enabled: boolean): Promise<UpdateStatus> {
    this.assertAvailable();
    const previous = this.value.automaticUpdates;
    try {
      await writePreference(this.options.dataDirectory, enabled);
      this.set({ automaticUpdates: enabled });
      if (this.value.error === PREFERENCE_ERROR)
        this.set({ error: null, phase: this.value.phase === 'error' ? 'idle' : this.value.phase });
    } catch {
      this.set({
        automaticUpdates: previous,
        phase: this.value.phase === 'idle' ? 'error' : this.value.phase,
        error: 'The update preference could not be saved. The previous setting remains active.',
      });
    }
    if (this.value.automaticUpdates) this.scheduleChecks();
    else this.clearTimers();
    this.publish();
    return this.status();
  }

  async restart(): Promise<QuitStatus> {
    this.assertAvailable();
    const info = Updater.updateInfo();
    if (
      !info.updateReady ||
      !info.version ||
      !isHigherStableVersion(info.version, this.options.installedVersion)
    )
      throw new RequestError('No verified update is ready to install.');
    let cleaned: boolean;
    try {
      cleaned = await this.options.quit.beginUpdateRestart();
    } catch {
      throw new RequestError(
        'Update cleanup failed. The app has not exited. Use Quit, then reopen the app to retry the update.',
      );
    }
    if (!cleaned) throw new RequestError('Quit cleanup has started. Retry Quit to close the app.');
    this.update({ phase: 'restarting', error: null });
    const mark = Updater.getStatusHistory().length;
    this.restartApproved = true;
    this.options.quit.approveUpdateRestart();
    let applyError: string | undefined;
    try {
      await Updater.applyUpdate();
    } catch (error) {
      applyError = errorMessage(error);
    } finally {
      this.restartApproved = false;
      this.options.quit.clearUpdateRestart();
    }
    const entries = Updater.getStatusHistory().slice(mark);
    if (entries.some((entry) => entry.status === 'launching-new-version'))
      return this.options.quit.status();
    const failure = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.status === 'error' || entry.status === 'idle' || entry.status === 'no-update',
      );
    const message = applyError ?? failure?.message ?? 'The update restart reported no outcome.';
    this.update({ phase: 'error', error: message });
    this.options.quit.updateRestartFailed(
      `Update handoff failed. The gateway is stopped. Quit and reopen the app to retry the update. ${message}`,
    );
    return this.options.quit.status();
  }

  private async performCheck(): Promise<UpdateStatus> {
    this.update({ phase: 'checking', error: null });
    this.lastCheckAt = Date.now();
    try {
      const info = await Updater.checkForUpdate();
      if (this.stopped) return this.status();
      const eligible =
        info.updateAvailable && isHigherStableVersion(info.version, this.options.installedVersion);
      this.update({
        availableVersion: eligible ? info.version : null,
        phase: eligible ? 'available' : info.updateAvailable || info.error ? 'error' : 'idle',
        error: info.error
          ? info.error
          : info.updateAvailable && !eligible
            ? 'The offered update version is not eligible.'
            : null,
        checkedAt: new Date().toISOString(),
      });
      if (eligible && this.value.automaticUpdates) void this.download().catch(() => undefined);
      return this.status();
    } catch (error) {
      if (this.stopped) return this.status();
      this.update({ phase: 'error', error: errorMessage(error) });
      return this.status();
    }
  }

  private async performDownload(): Promise<UpdateStatus> {
    this.update({ phase: 'downloading', error: null });
    try {
      await Updater.downloadUpdate();
      if (this.stopped) return this.status();
      const info = Updater.updateInfo();
      this.update(
        info.updateReady &&
          info.version &&
          isHigherStableVersion(info.version, this.options.installedVersion)
          ? { availableVersion: info.version, phase: 'ready', error: null }
          : {
              phase: 'error',
              error: info.error || 'The update download did not complete.',
            },
      );
      return this.status();
    } catch (error) {
      if (this.stopped) return this.status();
      this.update({ phase: 'error', error: errorMessage(error) });
      return this.status();
    }
  }

  private handleSdkStatus(entry: UpdateStatusEntry): void {
    const info = Updater.updateInfo();
    switch (entry.status) {
      case 'checking':
        this.update({ phase: 'checking', error: null });
        return;
      case 'update-available':
        this.update(
          isHigherStableVersion(info.version, this.options.installedVersion)
            ? { phase: 'available', availableVersion: info.version, error: null }
            : {
                phase: 'error',
                availableVersion: null,
                error: 'The offered update version is not eligible.',
              },
        );
        return;
      case 'no-update':
        this.update({ phase: 'idle', error: null });
        return;
      case 'download-starting':
      case 'downloading':
        this.update({ phase: 'downloading', error: null });
        return;
      case 'download-complete':
        this.update(
          info.version && isHigherStableVersion(info.version, this.options.installedVersion)
            ? { phase: 'ready', availableVersion: info.version, error: null }
            : { phase: 'error', error: 'The offered update version is not eligible.' },
        );
        return;
      case 'applying':
        this.update({ phase: 'restarting', error: null });
        return;
      case 'launching-new-version':
        if (this.restartApproved) this.update({ phase: 'restarting', error: null });
        return;
      case 'error':
        this.update({ phase: 'error', error: entry.message });
        return;
      case 'idle':
        this.update({ phase: 'idle', error: null });
        return;
      default:
        return;
    }
  }

  private seedFromSdk(): void {
    const terminal = [...Updater.getStatusHistory()]
      .reverse()
      .find(
        (entry) =>
          entry.status === 'error' ||
          entry.status === 'no-update' ||
          entry.status === 'download-complete' ||
          entry.status === 'update-available' ||
          entry.status === 'idle',
      );
    if (terminal?.status === 'error') this.set({ phase: 'error', error: terminal.message });
    else if (terminal?.status === 'no-update' || terminal?.status === 'idle')
      this.set({ phase: 'idle', error: null });
    else if (terminal?.status === 'download-complete') {
      const info = Updater.updateInfo();
      if (info.version && isHigherStableVersion(info.version, this.options.installedVersion))
        this.set({ phase: 'ready', availableVersion: info.version });
    } else if (terminal?.status === 'update-available') {
      const info = Updater.updateInfo();
      if (info.version && isHigherStableVersion(info.version, this.options.installedVersion))
        this.set({ phase: 'available', availableVersion: info.version });
    }
    const info = Updater.updateInfo();
    if (
      info.updateReady &&
      info.version &&
      isHigherStableVersion(info.version, this.options.installedVersion)
    )
      this.set({ phase: 'ready', availableVersion: info.version });
    else if (
      info.updateAvailable &&
      info.version &&
      isHigherStableVersion(info.version, this.options.installedVersion)
    )
      this.set({ phase: 'available', availableVersion: info.version });
    if (info.error) this.set({ phase: 'error', error: info.error });
  }

  private scheduleChecks(): void {
    if (!this.started || this.stopped || !this.value.automaticUpdates) return;
    this.clearTimers();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      this.scheduledCheck();
    }, STARTUP_DELAY_MS);
    this.intervalTimer = setInterval(() => {
      // A failed check or download is retried at the next poll instead of waiting a day.
      const elapsed = Date.now() - this.lastCheckAt;
      if (
        elapsed >= CHECK_INTERVAL_MS ||
        (this.value.phase === 'error' && elapsed >= POLL_INTERVAL_MS)
      )
        this.scheduledCheck();
    }, POLL_INTERVAL_MS);
  }

  private scheduledCheck(): void {
    if (
      !this.started ||
      this.stopped ||
      !this.value.automaticUpdates ||
      this.value.phase === 'ready' ||
      this.value.phase === 'restarting'
    )
      return;
    void this.check().catch(() => undefined);
  }

  private clearTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = undefined;
    this.intervalTimer = undefined;
  }

  private assertAvailable(): void {
    if (!this.options.supported) throw new RequestError('Updates are unavailable in this build.');
    if (this.stopped)
      throw new RequestError('Update work is unavailable after shutdown has started.');
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.value = { ...this.value, ...patch };
  }

  private update(patch: Partial<UpdateStatus>): void {
    this.set(patch);
    this.publish();
  }

  private publish(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}
