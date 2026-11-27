import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Updater, type UpdateStatusEntry } from 'electrobun/main';

import { RequestError, sanitizeErrorText } from '@mcp-gateway/core/errors';
import { runCommand } from '@mcp-gateway/core/process';
import type { QuitCoordinator } from '@mcp-gateway/main/lifecycle';
import { readPrivateJson, writePrivateJsonAtomic } from '@mcp-gateway/main/preferences-store';
import type { QuitStatus, UpdateStatus } from '@mcp-gateway/shared/rpc';
import type { UpdateDownloadProgress } from '@mcp-gateway/shared/types';

const PREFERENCE_FILE = 'updates.json';
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SAFE_HASH = /^[a-z0-9]{1,13}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 60 * 60 * 1_000;
const PREFERENCE_ERROR =
  'Update preferences are invalid or unsafe. Background updates are disabled.';

export interface UpdateRuntime {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  setAutomatic(enabled: boolean): Promise<UpdateStatus>;
  restart(): Promise<QuitStatus>;
  start(): Promise<UpdateStatus>;
  stop(): void;
  subscribe(listener: (status: UpdateStatus) => void): () => void;
}

export const resolveUpdateSupport = async () => {
  const info = await Updater.getLocalInfo();
  const installedVersion = STABLE_VERSION.test(info.version) ? info.version : null;
  return {
    supported: info.channel === 'stable' && installedVersion !== null && info.baseUrl.length > 0,
    installedVersion,
  };
};

const extractTeamIdentifier = (output: string) =>
  /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() ?? null;

export const verifyStagedAppBundleSignature = async (
  stagedAppPath: string,
  installedAppPath = resolve(dirname(process.execPath), '..', '..'),
) => {
  const verified = await runCommand('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    stagedAppPath,
  ]);
  if (verified.exitCode !== 0)
    throw new Error('Staged update failed codesign integrity verification.');
  const stagedDisplay = await runCommand('/usr/bin/codesign', [
    '-dv',
    '--verbose=4',
    stagedAppPath,
  ]);
  if (stagedDisplay.exitCode !== 0)
    throw new Error('Could not inspect staged update signing identity.');
  try {
    const installedStat = await lstat(installedAppPath);
    if (
      installedStat.isDirectory() &&
      !installedStat.isSymbolicLink() &&
      installedAppPath.endsWith('.app')
    ) {
      const installedDisplay = await runCommand('/usr/bin/codesign', [
        '-dv',
        '--verbose=4',
        installedAppPath,
      ]);
      if (installedDisplay.exitCode === 0) {
        const installedTeam = extractTeamIdentifier(
          `${installedDisplay.stdout}\n${installedDisplay.stderr}`,
        );
        const stagedTeam = extractTeamIdentifier(
          `${stagedDisplay.stdout}\n${stagedDisplay.stderr}`,
        );
        if (
          installedTeam &&
          installedTeam !== 'not set' &&
          (!stagedTeam || stagedTeam !== installedTeam)
        )
          throw new Error('Staged update signing TeamIdentifier does not match the installed app.');
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Staged update signing TeamIdentifier does not match the installed app.'
    )
      throw error;
  }
};

export const verifyDownloadedUpdate = async (expected: { version: string; hash?: string }) => {
  const localInfo = await Updater.getLocalInfo();
  const baseUrl = localInfo.baseUrl?.replace(/\/+$/, '');
  if (baseUrl) {
    let response: Response | undefined;
    try {
      response = await fetch(`${baseUrl}/stable-macos-arm64-update-v2.json`, {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      response = undefined;
    }
    if (response && response.status !== 404) {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Update integrity manifest check failed (HTTP ${response.status}).`);
      }
      let document: unknown;
      try {
        document = await response.json();
      } catch {
        throw new Error('Update integrity manifest contains invalid JSON.');
      }
      if (typeof document !== 'object' || document === null || Array.isArray(document))
        throw new Error('Update integrity manifest must be an object.');
      const manifest = document as Record<string, unknown>;
      const artifact =
        typeof manifest.artifact === 'object' &&
        manifest.artifact !== null &&
        !Array.isArray(manifest.artifact)
          ? (manifest.artifact as Record<string, unknown>)
          : null;
      if (
        manifest.schemaVersion !== 1 ||
        (localInfo.identifier && manifest.identifier !== localInfo.identifier) ||
        manifest.channel !== 'stable' ||
        manifest.version !== expected.version ||
        typeof manifest.hash !== 'string' ||
        !SAFE_HASH.test(manifest.hash) ||
        (expected.hash && manifest.hash !== expected.hash) ||
        !artifact ||
        typeof artifact.tarSha256 !== 'string' ||
        !SHA256_HEX.test(artifact.tarSha256) ||
        typeof artifact.tarSize !== 'number' ||
        !Number.isSafeInteger(artifact.tarSize) ||
        artifact.tarSize <= 0 ||
        artifact.tarSize > MAX_ARCHIVE_BYTES
      )
        throw new Error('Downloaded update failed integrity manifest verification.');
    } else if (response) {
      await response.body?.cancel().catch(() => undefined);
    }
  }

  let channelRoot: string | undefined;
  try {
    channelRoot = await Updater.appDataFolder();
  } catch {
    channelRoot = undefined;
  }
  if (!channelRoot) return;
  const preparedPath = join(channelRoot, 'self-extraction', '.electrobun-prepared-update.json');
  try {
    const stat = await lstat(preparedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const prepared = JSON.parse(await readFile(preparedPath, 'utf8')) as Record<string, unknown>;
    if (typeof prepared.staging_path === 'string' && prepared.staging_path.length > 0) {
      const stagedStat = await lstat(prepared.staging_path);
      if (stagedStat.isDirectory() && !stagedStat.isSymbolicLink())
        await verifyStagedAppBundleSignature(prepared.staging_path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
};

const invalidPreference = () => ({ automaticUpdates: false, error: PREFERENCE_ERROR });

const readPreference = async (dataDirectory: string) => {
  const path = join(dataDirectory, PREFERENCE_FILE);
  const result = await readPrivateJson(path, (record) => {
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== 'automaticUpdates' ||
      keys[1] !== 'schema_version' ||
      typeof record.automaticUpdates !== 'boolean'
    )
      return;
    return record.automaticUpdates;
  });
  if (result.status === 'missing') return { automaticUpdates: true, error: null };
  if (result.status === 'invalid') return invalidPreference();
  return { automaticUpdates: result.value, error: null };
};

const writePreference = async (dataDirectory: string, automaticUpdates: boolean) => {
  const path = join(dataDirectory, PREFERENCE_FILE);
  await writePrivateJsonAtomic(path, { automaticUpdates });
};

const errorMessage = (error: unknown, fallback = 'The update operation failed.') =>
  sanitizeErrorText(error, fallback, 240);

const extractDownloadProgress = (
  entry?: UpdateStatusEntry,
  previous?: UpdateDownloadProgress | null,
) => {
  const details = entry?.details;
  const info = Updater.updateInfo() as unknown as Record<string, unknown>;
  const rawBytes =
    typeof details?.bytesDownloaded === 'number' &&
    Number.isFinite(details.bytesDownloaded) &&
    details.bytesDownloaded >= 0
      ? Math.floor(details.bytesDownloaded)
      : typeof info.bytesDownloaded === 'number' &&
          Number.isFinite(info.bytesDownloaded) &&
          info.bytesDownloaded >= 0
        ? Math.floor(info.bytesDownloaded)
        : null;
  const rawTotal =
    typeof details?.totalBytes === 'number' &&
    Number.isFinite(details.totalBytes) &&
    details.totalBytes > 0
      ? Math.floor(details.totalBytes)
      : typeof info.totalBytes === 'number' &&
          Number.isFinite(info.totalBytes) &&
          info.totalBytes > 0
        ? Math.floor(info.totalBytes)
        : null;
  const rawProgress =
    typeof details?.progress === 'number' && Number.isFinite(details.progress)
      ? details.progress
      : typeof info.progress === 'number' && Number.isFinite(info.progress)
        ? info.progress
        : null;

  const bytesDownloaded = rawBytes ?? previous?.bytesDownloaded ?? 0;
  const totalBytes = rawTotal ?? previous?.totalBytes ?? null;
  const computedPercent =
    rawProgress !== null
      ? Math.min(100, Math.max(0, Math.floor(rawProgress)))
      : totalBytes !== null && totalBytes > 0 && (rawBytes !== null || bytesDownloaded > 0)
        ? Math.min(100, Math.max(0, Math.floor((bytesDownloaded / totalBytes) * 100)))
        : (previous?.percent ?? null);

  return {
    percent: computedPercent,
    bytesDownloaded,
    totalBytes,
  };
};

interface UpdaterOptions {
  dataDirectory: string;
  supported: boolean;
  installedVersion: string | null;
  quit: QuitCoordinator;
}

export class AppUpdater implements UpdateRuntime {
  private value: UpdateStatus;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private started = false;
  private stopped = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private lastCheckAt = 0;

  constructor(private readonly options: UpdaterOptions) {
    this.value = {
      supported: options.supported,
      automaticUpdates: false,
      installedVersion: options.installedVersion,
      availableVersion: null,
      phase: 'idle',
      progressPercent: null,
      downloadedBytes: null,
      totalBytes: null,
      downloadProgress: null,
      error: null,
      checkedAt: null,
    };
  }

  status() {
    const dp = this.value.downloadProgress ? { ...this.value.downloadProgress } : null;
    const isReady = this.value.phase === 'ready';
    const progressPercent = isReady ? 100 : (dp?.percent ?? (dp ? 0 : null));
    const downloadedBytes = dp?.bytesDownloaded ?? null;
    const totalBytes = dp?.totalBytes ?? null;
    return {
      ...this.value,
      progressPercent,
      downloadedBytes,
      totalBytes,
      downloadProgress: dp,
    };
  }

  subscribe(listener: (status: UpdateStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start() {
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

  stop() {
    this.stopped = true;
    this.clearTimers();
    Updater.onStatusChange(null);
    this.listeners.clear();
  }

  async check() {
    this.assertAvailable();
    if (this.value.phase === 'restarting')
      throw new RequestError('An update restart is already in progress.');
    if (this.value.phase === 'downloading' || this.value.phase === 'ready') return this.status();
    return this.performCheck();
  }

  async download() {
    this.assertAvailable();
    if (this.value.phase === 'restarting')
      throw new RequestError('An update restart is already in progress.');
    if (this.value.phase === 'checking')
      throw new RequestError('An update check is already in progress.');
    if (this.value.phase === 'downloading') return this.status();
    if (this.value.phase === 'ready') return this.status();
    if (!this.value.availableVersion || !this.eligible(this.value.availableVersion))
      throw new RequestError('No eligible update is available to download.');
    // The download can outlive the window's request limit; its phase is polled.
    void this.performDownload().catch((error: unknown) =>
      this.update({ phase: 'error', downloadProgress: null, error: errorMessage(error) }),
    );
    return this.status();
  }

  async installUpdate() {
    this.assertAvailable();
    if (this.value.phase === 'restarting')
      throw new RequestError('An update restart is already in progress.');
    if (this.value.phase === 'checking')
      throw new RequestError('An update check is already in progress.');
    if (this.value.phase === 'downloading') return this.status();
    if (this.value.phase === 'ready') {
      await this.restart();
      return this.status();
    }
    if (!this.value.availableVersion || !this.eligible(this.value.availableVersion))
      throw new RequestError('No eligible update is available to download.');
    void (async () => {
      try {
        const downloaded = await this.performDownload();
        if (downloaded.phase === 'ready' && !this.stopped) {
          await this.restart();
        }
      } catch (error) {
        this.update({ phase: 'error', downloadProgress: null, error: errorMessage(error) });
      }
    })();
    return this.status();
  }

  async setAutomatic(enabled: boolean) {
    this.assertAvailable();
    // A failed write reaches the caller as a failed request; the previous setting stays active.
    await writePreference(this.options.dataDirectory, enabled);
    this.set({ automaticUpdates: enabled });
    if (this.value.error === PREFERENCE_ERROR)
      this.set({ error: null, phase: this.value.phase === 'error' ? 'idle' : this.value.phase });
    if (this.value.automaticUpdates) this.scheduleChecks();
    else this.clearTimers();
    this.publish();
    return this.status();
  }

  async restart() {
    this.assertAvailable();
    const info = Updater.updateInfo();
    if (!info.updateReady || !info.version || !this.eligible(info.version))
      throw new RequestError('No verified update is ready to install.');
    try {
      await verifyDownloadedUpdate({ version: info.version, hash: info.hash });
    } catch (error) {
      const message = errorMessage(error);
      this.update({ phase: 'error', downloadProgress: null, error: message });
      throw new RequestError(message);
    }
    let cleaned: boolean;
    try {
      cleaned = await this.options.quit.beginUpdateRestart();
    } catch {
      throw new RequestError(
        'Update cleanup failed. The app has not exited. Use Quit, then reopen the app to retry the update.',
      );
    }
    if (!cleaned) throw new RequestError('Quit cleanup has started. Retry Quit to close the app.');
    this.update({ phase: 'restarting', downloadProgress: null, error: null });
    const mark = Updater.getStatusHistory().length;
    this.options.quit.approveUpdateRestart();
    let applyError: string | undefined;
    try {
      await Updater.applyUpdate();
    } catch (error) {
      applyError = errorMessage(error);
    } finally {
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
    const message =
      applyError ??
      (failure?.message
        ? errorMessage(failure.message, 'The update restart reported no outcome.')
        : 'The update restart reported no outcome.');
    this.update({ phase: 'error', downloadProgress: null, error: message });
    this.options.quit.updateRestartFailed(
      `Update handoff failed. The gateway is stopped. Quit and reopen the app to retry the update. ${message}`,
    );
    return this.options.quit.status();
  }

  private async performCheck() {
    this.update({ phase: 'checking', downloadProgress: null, error: null });
    this.lastCheckAt = Date.now();
    try {
      const info = await Updater.checkForUpdate();
      if (this.stopped) return this.status();
      const eligible = info.updateAvailable && this.eligible(info.version);
      this.update({
        availableVersion: eligible ? info.version : null,
        phase: eligible ? 'available' : info.updateAvailable || info.error ? 'error' : 'idle',
        downloadProgress: null,
        error: info.error
          ? errorMessage(info.error)
          : info.updateAvailable && !eligible
            ? 'The offered update version is not eligible.'
            : null,
        checkedAt: new Date().toISOString(),
      });
      if (eligible && this.value.automaticUpdates) void this.download().catch(() => undefined);
      return this.status();
    } catch (error) {
      if (this.stopped) return this.status();
      this.update({ phase: 'error', downloadProgress: null, error: errorMessage(error) });
      return this.status();
    }
  }

  private async performDownload() {
    this.update({
      phase: 'downloading',
      downloadProgress: extractDownloadProgress(undefined, this.value.downloadProgress),
      error: null,
    });
    try {
      await Updater.downloadUpdate();
      if (this.stopped) return this.status();
      const info = Updater.updateInfo();
      if (info.updateReady && info.version && this.eligible(info.version)) {
        await verifyDownloadedUpdate({ version: info.version, hash: info.hash });
        if (this.stopped) return this.status();
        this.update({
          availableVersion: info.version,
          phase: 'ready',
          downloadProgress: null,
          error: null,
        });
      } else {
        this.update({
          phase: 'error',
          downloadProgress: null,
          error: info.error
            ? errorMessage(info.error, 'The update download did not complete.')
            : 'The update download did not complete.',
        });
      }
      return this.status();
    } catch (error) {
      if (this.stopped) return this.status();
      this.update({ phase: 'error', downloadProgress: null, error: errorMessage(error) });
      return this.status();
    }
  }

  private handleSdkStatus(entry: UpdateStatusEntry) {
    const info = Updater.updateInfo();
    switch (entry.status) {
      case 'checking':
        this.update({ phase: 'checking', downloadProgress: null, error: null });
        return;
      case 'update-available':
        this.update(
          this.eligible(info.version)
            ? {
                phase: 'available',
                availableVersion: info.version,
                downloadProgress: null,
                error: null,
              }
            : {
                phase: 'error',
                availableVersion: null,
                downloadProgress: null,
                error: 'The offered update version is not eligible.',
              },
        );
        return;
      case 'no-update':
        this.update({ phase: 'idle', downloadProgress: null, error: null });
        return;
      case 'download-starting':
      case 'downloading':
      case 'downloading-patch':
      case 'downloading-full-bundle':
      case 'download-progress':
      case 'applying-patch':
      case 'decompressing':
        this.update({
          phase: 'downloading',
          downloadProgress: extractDownloadProgress(entry, this.value.downloadProgress),
          error: null,
        });
        return;
      case 'download-complete':
        this.update(
          info.version && this.eligible(info.version)
            ? {
                phase: 'ready',
                availableVersion: info.version,
                downloadProgress: null,
                error: null,
              }
            : {
                phase: 'error',
                downloadProgress: null,
                error: 'The offered update version is not eligible.',
              },
        );
        return;
      case 'applying':
        this.update({ phase: 'restarting', downloadProgress: null, error: null });
        return;
      case 'error':
        this.update({
          phase: 'error',
          downloadProgress: null,
          error: errorMessage(entry.message),
        });
        return;
      case 'idle':
        this.update({ phase: 'idle', downloadProgress: null, error: null });
        return;
      default:
        return;
    }
  }

  private seedFromSdk() {
    const info = Updater.updateInfo();
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
    if (terminal?.status === 'error')
      this.set({
        phase: 'error',
        downloadProgress: null,
        error: errorMessage(terminal.message),
      });
    else if (terminal?.status === 'no-update' || terminal?.status === 'idle')
      this.set({ phase: 'idle', downloadProgress: null, error: null });
    else if (terminal?.status === 'download-complete') {
      if (info.version && this.eligible(info.version))
        this.set({ phase: 'ready', availableVersion: info.version, downloadProgress: null });
    } else if (terminal?.status === 'update-available') {
      if (info.version && this.eligible(info.version))
        this.set({ phase: 'available', availableVersion: info.version, downloadProgress: null });
    }
    if (info.updateReady && info.version && this.eligible(info.version))
      this.set({ phase: 'ready', availableVersion: info.version, downloadProgress: null });
    else if (info.updateAvailable && info.version && this.eligible(info.version))
      this.set({ phase: 'available', availableVersion: info.version, downloadProgress: null });
    if (info.error)
      this.set({ phase: 'error', downloadProgress: null, error: errorMessage(info.error) });
  }

  private scheduleChecks() {
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

  private scheduledCheck() {
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

  private clearTimers() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = undefined;
    this.intervalTimer = undefined;
  }

  /** Whether `candidate` is a stable version higher than the installed one. */
  private eligible(candidate: string) {
    const installed = this.options.installedVersion;
    if (!installed || !STABLE_VERSION.test(candidate) || !STABLE_VERSION.test(installed))
      return false;
    try {
      return Bun.semver.order(candidate, installed) === 1;
    } catch {
      return false;
    }
  }

  private assertAvailable() {
    if (!this.options.supported) throw new RequestError('Updates are unavailable in this build.');
    if (this.stopped)
      throw new RequestError('Update work is unavailable after shutdown has started.');
  }

  private set(patch: Partial<UpdateStatus>) {
    this.value = { ...this.value, ...patch };
  }

  private update(patch: Partial<UpdateStatus>) {
    this.set(patch);
    this.publish();
  }

  private publish() {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}
