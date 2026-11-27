import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';

import type { Updater, UpdateStatusEntry } from 'electrobun/main';

import { failure, RequestError } from '@mcp-gateway/core/errors';
import * as processModule from '@mcp-gateway/core/process';
import type { UpdateRuntime } from '@mcp-gateway/main/app-updater';
import { QuitCoordinator } from '@mcp-gateway/main/lifecycle';
import { AppService, type LoginManager } from '@mcp-gateway/main/service';
import { MAX_CONFIG_BYTES } from '@mcp-gateway/shared/config-document';
import {
  CATALOG_LOCALES,
  type LanguagePreference,
  type LanguageState,
  languageState,
} from '@mcp-gateway/shared/i18n';
import type { LoginStatus, QuitStatus, UpdateStatus } from '@mcp-gateway/shared/rpc';
import type {
  GatewayConfig,
  GatewayController,
  GatewayOperation,
  GatewaySnapshot,
  KeyMigration,
  LogPage,
  LogQuery,
  ServerCheckResult,
} from '@mcp-gateway/shared/types';

type LocalUpdateInfo = Awaited<ReturnType<typeof Updater.getLocalInfo>>;
type UpdateInfo = ReturnType<typeof Updater.updateInfo>;

// Mock electrobun/main before importing app-updater so Bun never tries to load
// native Electrobun FFI libraries outside a packaged app bundle.
interface SdkMockState {
  localInfo: LocalUpdateInfo;
  updateInfo: UpdateInfo & {
    bytesDownloaded?: number;
    totalBytes?: number;
    progress?: number;
  };
  statusHistory: UpdateStatusEntry[];
  statusListener: ((entry: UpdateStatusEntry) => void) | null;
  onStatusChangeCalls: Array<((entry: UpdateStatusEntry) => void) | null>;
  appDataFolder: string;
  checkForUpdateImpl: () => Promise<UpdateInfo>;
  downloadUpdateImpl: () => Promise<void>;
  applyUpdateImpl: () => Promise<void>;
}

const defaultSdkState = (): SdkMockState => ({
  localInfo: {
    version: '0.9.0',
    hash: 'abc1234',
    baseUrl: 'https://updates.example.com',
    channel: 'stable',
    name: 'Bear MCP Gateway',
    identifier: 'com.zaherg.mcp-gateway',
  },
  updateInfo: {
    version: '',
    hash: '',
    updateAvailable: false,
    updateReady: false,
    error: '',
  },
  statusHistory: [],
  statusListener: null,
  onStatusChangeCalls: [],
  appDataFolder: '',
  checkForUpdateImpl: async () => sdkState.updateInfo,
  downloadUpdateImpl: async () => {},
  applyUpdateImpl: async () => {},
});

let sdkState: SdkMockState = defaultSdkState();

const mockSdkUpdater = {
  getLocalInfo: async (): Promise<LocalUpdateInfo> => sdkState.localInfo,
  updateInfo: (): UpdateInfo => sdkState.updateInfo,
  getStatusHistory: (): UpdateStatusEntry[] => [...sdkState.statusHistory],
  onStatusChange: (cb: ((entry: UpdateStatusEntry) => void) | null): void => {
    sdkState.onStatusChangeCalls.push(cb);
    sdkState.statusListener = cb;
  },
  checkForUpdate: async (): Promise<UpdateInfo> => sdkState.checkForUpdateImpl(),
  downloadUpdate: async (): Promise<void> => sdkState.downloadUpdateImpl(),
  applyUpdate: async (): Promise<void> => sdkState.applyUpdateImpl(),
  appDataFolder: async (): Promise<string> => sdkState.appDataFolder,
};

mock.module('electrobun/main', () => ({ Updater: mockSdkUpdater }));

const { AppUpdater, resolveUpdateSupport, verifyDownloadedUpdate, verifyStagedAppBundleSignature } =
  await import('@mcp-gateway/main/app-updater');

const VALID_REVISION = 'a'.repeat(64);
const OTHER_REVISION = 'b'.repeat(64);
const GATEWAY_TOKEN = 'g'.repeat(40);
const SERVER_TOKEN = 's'.repeat(40);
const VALID_SHA256 = 'f'.repeat(64);
const PREFERENCE_ERROR =
  'Update preferences are invalid or unsafe. Background updates are disabled.';

const BASE_CONFIG: GatewayConfig = {
  gateway: {
    host: '127.0.0.1',
    port: 3333,
    token: GATEWAY_TOKEN,
    autoStart: false,
    launchAtLogin: false,
  },
  mcpServers: {
    alpha: {
      command: '/usr/bin/env',
      args: ['node', 'alpha.js'],
      env: { API_SECRET: 'do-not-leak' },
      token: SERVER_TOKEN,
    },
    beta: {
      url: 'https://upstream.example.com/mcp',
      headers: { 'X-Upstream-Secret': 'do-not-leak' },
    },
  },
};

const makeConfigText = (config: GatewayConfig = BASE_CONFIG): string =>
  `${JSON.stringify(config, null, 2)}\n`;

const makeUpdateStatus = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  supported: true,
  automaticUpdates: true,
  installedVersion: '0.9.0',
  availableVersion: null,
  phase: 'idle',
  progressPercent: null,
  downloadedBytes: null,
  totalBytes: null,
  downloadProgress: null,
  error: null,
  checkedAt: null,
  ...overrides,
});

const tempDirs: string[] = [];
const lockedDirs: string[] = [];
const activeSpies: Array<{ mockRestore(): void }> = [];
const activeUpdaters: Array<InstanceType<typeof AppUpdater>> = [];

const makeTempDir = async (prefix = 'mcp-gateway-service-test-'): Promise<string> => {
  const dir = await mkdtemp(join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const trackSpy = <T extends { mockRestore(): void }>(spy: T): T => {
  activeSpies.push(spy);
  return spy;
};

const trackUpdater = (
  updater: InstanceType<typeof AppUpdater>,
): InstanceType<typeof AppUpdater> => {
  activeUpdaters.push(updater);
  return updater;
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

interface TestHarnessOptions {
  configPath?: string;
  configText?: string;
  revision?: string;
  activeConfig?: GatewayConfig | undefined;
  configError?: GatewaySnapshot['configError'];
  keyMigration?: KeyMigration;
  loginStatus?: LoginStatus;
  quitStatus?: QuitStatus;
  updateStatus?: UpdateStatus;
  whatsNew?: string | null;
  keyReminderRetired?: boolean;
  language?: LanguageState;
}

const createServiceHarness = (options: TestHarnessOptions = {}) => {
  let activeConfig: GatewayConfig | undefined =
    'activeConfig' in options ? options.activeConfig : structuredClone(BASE_CONFIG);
  let snapshotState: GatewaySnapshot = {
    configPath: options.configPath ?? '/tmp/nonexistent-mcp-gateway/mcp.json',
    configFormat: 'json',
    configText: options.configText ?? makeConfigText(activeConfig ?? BASE_CONFIG),
    revision: options.revision ?? VALID_REVISION,
    running: true,
    interfaces: [{ name: 'lo0', address: '127.0.0.1', netmask: '255.0.0.0', kind: 'loopback' }],
    network: 'loopback',
    keyMigration: options.keyMigration ?? { gateway: false, servers: [] },
    servers: [
      {
        name: 'alpha',
        type: 'stdio',
        endpoint: 'http://127.0.0.1:3333/mcp/alpha',
        enabled: true,
        status: 'mounted',
        error: null,
      },
      {
        name: 'beta',
        type: 'http',
        endpoint: 'http://127.0.0.1:3333/mcp/beta',
        enabled: true,
        status: 'mounted',
        error: null,
      },
    ],
    configError: options.configError ?? null,
    operationalError: null,
  };

  let loginStatus: LoginStatus = options.loginStatus ?? {
    enabled: false,
    supported: true,
    error: null,
  };
  let quitStatus: QuitStatus = options.quitStatus ?? { attempt: 0, phase: 'idle', error: null };
  let updateStatus: UpdateStatus = options.updateStatus ?? makeUpdateStatus();
  let whatsNew: string | null = options.whatsNew ?? '0.9.0';
  let keyReminderRetired = options.keyReminderRetired ?? false;
  let language: LanguageState =
    options.language ?? languageState('system', 'en_US', [...CATALOG_LOCALES]);

  const copiedTexts: string[] = [];
  const recordedErrors: unknown[] = [];
  const openedExternal: string[] = [];
  const shownInFolder: string[] = [];
  const openedPaths: string[] = [];
  const loginSetCalls: boolean[] = [];
  const saveConfigCalls: Array<{
    text: string;
    expectedRevision: string;
    operation?: GatewayOperation;
  }> = [];
  const migrateKeysCalls: Array<{
    slots: KeyMigration;
    expectedRevision: string;
    operation?: GatewayOperation;
  }> = [];
  const restartServerCalls: Array<{ name: string; operation?: GatewayOperation }> = [];
  const testServerCalls: Array<{ name: string; expectedRevision: string }> = [];
  const startCalls: Array<GatewayOperation | undefined> = [];
  let stopCalls = 0;
  let clearLogsCalls = 0;
  const readLogsCalls: LogQuery[] = [];
  let loginStatusCalls = 0;
  let retireKeyReminderCalls = 0;
  let dismissWhatsNewCalls = 0;
  let requestQuitCalls = 0;
  let confirmDiscardCalls = 0;
  const confirmDeleteCalls: string[] = [];
  const setLanguageCalls: LanguagePreference[] = [];
  let updatesCheckCalls = 0;
  let updatesDownloadCalls = 0;
  let updatesInstallCalls = 0;
  const updatesSetAutomaticCalls: boolean[] = [];
  let updatesRestartCalls = 0;

  let openExternalResult = true;
  let openPathResult = true;
  let confirmDiscardResult = true;
  let confirmDeleteResult = true;
  let logPage: LogPage = { entries: [], cursor: 0, generation: 1, gap: false, hasMore: false };
  let testServerResult: ServerCheckResult = { protocolVersion: '2025-11-25' };

  let onStart: ((operation?: GatewayOperation) => Promise<void> | void) | undefined;
  let onStop: (() => Promise<void> | void) | undefined;
  let onRestartServer:
    | ((name: string, operation?: GatewayOperation) => Promise<void> | void)
    | undefined;
  let onTestServer:
    | ((name: string, expectedRevision: string) => Promise<ServerCheckResult> | ServerCheckResult)
    | undefined;
  let onSaveConfig:
    | ((
        text: string,
        expectedRevision: string,
        operation?: GatewayOperation,
      ) => Promise<void> | void)
    | undefined;
  let onMigrateKeys:
    | ((
        slots: KeyMigration,
        expectedRevision: string,
        operation?: GatewayOperation,
      ) => Promise<void> | void)
    | undefined;
  let onRetireKeyReminder: (() => Promise<void> | void) | undefined;
  let onLoginSetEnabled: ((enabled: boolean) => LoginStatus) | undefined;
  let onUpdatesRestart: (() => Promise<QuitStatus>) | undefined;

  const controller: GatewayController = {
    readLogs: (query) => {
      readLogsCalls.push(query);
      return logPage;
    },
    clearLogs: () => {
      clearLogsCalls++;
      return {
        entries: [],
        cursor: 0,
        generation: logPage.generation + 1,
        gap: false,
        hasMore: false,
      };
    },
    recordLocalError: (error) => {
      recordedErrors.push(error);
    },
    snapshot: () => snapshotState,
    operation: () => ({ signal: new AbortController().signal }),
    start: async (operation) => {
      startCalls.push(operation);
      if (onStart) await onStart(operation);
      snapshotState = { ...snapshotState, running: true };
      return snapshotState;
    },
    stop: async () => {
      stopCalls++;
      if (onStop) await onStop();
      snapshotState = { ...snapshotState, running: false };
      return snapshotState;
    },
    restartServer: async (name, operation) => {
      restartServerCalls.push({ name, operation });
      if (onRestartServer) await onRestartServer(name, operation);
      return snapshotState;
    },
    testServer: async (name, expectedRevision) => {
      testServerCalls.push({ name, expectedRevision });
      if (onTestServer) return onTestServer(name, expectedRevision);
      return testServerResult;
    },
    saveConfig: async (text, expectedRevision, operation) => {
      saveConfigCalls.push({ text, expectedRevision, operation });
      if (onSaveConfig) await onSaveConfig(text, expectedRevision, operation);
      snapshotState = { ...snapshotState, configText: text };
      return snapshotState;
    },
    migrateKeys: async (slots, expectedRevision, operation) => {
      migrateKeysCalls.push({ slots, expectedRevision, operation });
      if (onMigrateKeys) await onMigrateKeys(slots, expectedRevision, operation);
      snapshotState = {
        ...snapshotState,
        keyMigration: {
          gateway: slots.gateway ? false : snapshotState.keyMigration.gateway,
          servers: snapshotState.keyMigration.servers.filter((s) => !slots.servers.includes(s)),
        },
      };
      return snapshotState;
    },
    activeConfig: () => activeConfig,
    close: async () => {},
  };

  const login: LoginManager = {
    status: () => {
      loginStatusCalls++;
      return loginStatus;
    },
    setEnabled: (enabled) => {
      loginSetCalls.push(enabled);
      if (onLoginSetEnabled) {
        loginStatus = onLoginSetEnabled(enabled);
      } else {
        loginStatus = { ...loginStatus, enabled, error: null };
      }
      return loginStatus;
    },
  };

  const desktop = {
    requestQuit: () => {
      requestQuitCalls++;
      quitStatus = { attempt: quitStatus.attempt + 1, phase: 'pending', error: null };
      return quitStatus;
    },
    quitStatus: () => quitStatus,
    openExternal: (url: string) => {
      openedExternal.push(url);
      return openExternalResult;
    },
    showItemInFolder: (path: string) => {
      shownInFolder.push(path);
    },
    openPath: (path: string) => {
      openedPaths.push(path);
      return openPathResult;
    },
    confirmDiscard: async () => {
      confirmDiscardCalls++;
      return confirmDiscardResult;
    },
    confirmDeleteServer: async (name: string) => {
      confirmDeleteCalls.push(name);
      return confirmDeleteResult;
    },
    whatsNew: () => whatsNew,
    dismissWhatsNew: async () => {
      dismissWhatsNewCalls++;
      whatsNew = null;
    },
    keyReminderRetired: () => keyReminderRetired,
    retireKeyReminder: async () => {
      retireKeyReminderCalls++;
      if (onRetireKeyReminder) await onRetireKeyReminder();
      keyReminderRetired = true;
    },
    language: () => language,
    setLanguage: async (preference: LanguagePreference) => {
      setLanguageCalls.push(preference);
      language = languageState(preference, language.system, language.available);
    },
  };

  const updates: UpdateRuntime = {
    status: () => updateStatus,
    check: async () => {
      updatesCheckCalls++;
      updateStatus = { ...updateStatus, phase: 'available', availableVersion: '0.10.0' };
      return updateStatus;
    },
    download: async () => {
      updatesDownloadCalls++;
      updateStatus = { ...updateStatus, phase: 'downloading' };
      return updateStatus;
    },
    installUpdate: async () => {
      updatesInstallCalls++;
      updateStatus = { ...updateStatus, phase: 'ready', availableVersion: '0.10.0' };
      return updateStatus;
    },
    setAutomatic: async (enabled: boolean) => {
      updatesSetAutomaticCalls.push(enabled);
      updateStatus = { ...updateStatus, automaticUpdates: enabled };
      return updateStatus;
    },
    restart: async () => {
      updatesRestartCalls++;
      if (onUpdatesRestart) return onUpdatesRestart();
      return { attempt: 1, phase: 'pending', error: null };
    },
    start: async () => updateStatus,
    stop: () => {},
    subscribe: () => () => {},
  };

  const service = new AppService(
    controller,
    login,
    (text) => copiedTexts.push(text),
    desktop,
    updates,
  );

  return {
    service,
    setSnapshot: (patch: Partial<GatewaySnapshot>) => {
      snapshotState = { ...snapshotState, ...patch };
    },
    setActiveConfig: (config: GatewayConfig | undefined) => {
      activeConfig = config;
    },
    setLoginStatus: (status: LoginStatus) => {
      loginStatus = status;
    },
    setQuitStatus: (status: QuitStatus) => {
      quitStatus = status;
    },
    setUpdateStatus: (status: UpdateStatus) => {
      updateStatus = status;
    },
    setOpenExternalResult: (value: boolean) => {
      openExternalResult = value;
    },
    setOpenPathResult: (value: boolean) => {
      openPathResult = value;
    },
    setConfirmDiscardResult: (value: boolean) => {
      confirmDiscardResult = value;
    },
    setConfirmDeleteResult: (value: boolean) => {
      confirmDeleteResult = value;
    },
    setLogPage: (page: LogPage) => {
      logPage = page;
    },
    setTestServerResult: (result: ServerCheckResult) => {
      testServerResult = result;
    },
    hooks: {
      setStart: (fn: typeof onStart) => {
        onStart = fn;
      },
      setStop: (fn: typeof onStop) => {
        onStop = fn;
      },
      setRestartServer: (fn: typeof onRestartServer) => {
        onRestartServer = fn;
      },
      setTestServer: (fn: typeof onTestServer) => {
        onTestServer = fn;
      },
      setSaveConfig: (fn: typeof onSaveConfig) => {
        onSaveConfig = fn;
      },
      setMigrateKeys: (fn: typeof onMigrateKeys) => {
        onMigrateKeys = fn;
      },
      setRetireKeyReminder: (fn: typeof onRetireKeyReminder) => {
        onRetireKeyReminder = fn;
      },
      setLoginSetEnabled: (fn: typeof onLoginSetEnabled) => {
        onLoginSetEnabled = fn;
      },
      setUpdatesRestart: (fn: typeof onUpdatesRestart) => {
        onUpdatesRestart = fn;
      },
    },
    calls: {
      copiedTexts,
      recordedErrors,
      openedExternal,
      shownInFolder,
      openedPaths,
      loginSetCalls,
      saveConfigCalls,
      migrateKeysCalls,
      restartServerCalls,
      testServerCalls,
      startCalls,
      readLogsCalls,
      confirmDeleteCalls,
      setLanguageCalls,
      updatesSetAutomaticCalls,
      get stopCalls() {
        return stopCalls;
      },
      get clearLogsCalls() {
        return clearLogsCalls;
      },
      get loginStatusCalls() {
        return loginStatusCalls;
      },
      get retireKeyReminderCalls() {
        return retireKeyReminderCalls;
      },
      get dismissWhatsNewCalls() {
        return dismissWhatsNewCalls;
      },
      get requestQuitCalls() {
        return requestQuitCalls;
      },
      get confirmDiscardCalls() {
        return confirmDiscardCalls;
      },
      get updatesCheckCalls() {
        return updatesCheckCalls;
      },
      get updatesDownloadCalls() {
        return updatesDownloadCalls;
      },
      get updatesInstallCalls() {
        return updatesInstallCalls;
      },
      get updatesRestartCalls() {
        return updatesRestartCalls;
      },
    },
  };
};

const makeQuitCoordinator = (cleanup: () => Promise<void> = async () => {}) => {
  const failures: Array<{ error: unknown; kind: 'quit' | 'update' }> = [];
  const coordinator = new QuitCoordinator(
    cleanup,
    () => {},
    (error, kind) => failures.push({ error, kind }),
  );
  return { coordinator, failures };
};

const mockFetchWith = (
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => trackSpy(spyOn(globalThis, 'fetch').mockImplementation(impl as typeof fetch));

beforeEach(() => {
  sdkState = defaultSdkState();
});

afterEach(async () => {
  while (activeUpdaters.length > 0) {
    activeUpdaters.pop()?.stop();
  }
  while (activeSpies.length > 0) {
    activeSpies.pop()?.mockRestore();
  }
  while (lockedDirs.length > 0) {
    const dir = lockedDirs.pop();
    if (dir) await chmod(dir, 0o700).catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('AppService — RPC parameter validation & error sanitization', () => {
  test('rejects invalid payload types across all parameterized handlers with InvalidRequest', async () => {
    const { service, calls } = createServiceHarness();

    const invalidCases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> =
      [
        ['readLogs non-object', () => service.handlers.readLogs('bad')],
        ['readLogs negative after', () => service.handlers.readLogs({ after: -1 })],
        ['readLogs float after', () => service.handlers.readLogs({ after: 1.5 })],
        ['readLogs NaN after', () => service.handlers.readLogs({ after: Number.NaN })],
        ['readLogs extra key', () => service.handlers.readLogs({ after: 0, extra: 1 })],
        ['restartServer bad type', () => service.handlers.restartServer({ name: 123 })],
        ['restartServer unsafe name', () => service.handlers.restartServer({ name: '../bad' })],
        [
          'restartServer prototype key',
          () => service.handlers.restartServer({ name: '__proto__' }),
        ],
        ['testServer missing rev', () => service.handlers.testServer({ name: 'alpha' })],
        [
          'testServer bad rev',
          () => service.handlers.testServer({ name: 'alpha', expectedRevision: 'not-sha256' }),
        ],
        [
          'testServer unsafe name',
          () => service.handlers.testServer({ name: 'bad/name', expectedRevision: VALID_REVISION }),
        ],
        [
          'saveConfig missing text',
          () => service.handlers.saveConfig({ expectedRevision: VALID_REVISION }),
        ],
        [
          'saveConfig bad rev',
          () => service.handlers.saveConfig({ text: '{}', expectedRevision: 'short' }),
        ],
        [
          'saveConfig oversized text',
          () =>
            service.handlers.saveConfig({
              text: 'x'.repeat(MAX_CONFIG_BYTES + 1),
              expectedRevision: VALID_REVISION,
            }),
        ],
        [
          'migrateKeys empty target',
          () =>
            service.handlers.migrateKeys({
              gateway: false,
              servers: [],
              expectedRevision: VALID_REVISION,
            }),
        ],
        [
          'migrateKeys bad rev',
          () =>
            service.handlers.migrateKeys({
              gateway: true,
              servers: [],
              expectedRevision: '1234',
            }),
        ],
        [
          'migrateKeys duplicate servers',
          () =>
            service.handlers.migrateKeys({
              gateway: false,
              servers: ['alpha', 'alpha'],
              expectedRevision: VALID_REVISION,
            }),
        ],
        [
          'migrateKeys unsafe server name',
          () =>
            service.handlers.migrateKeys({
              gateway: false,
              servers: ['bad name'],
              expectedRevision: VALID_REVISION,
            }),
        ],
        ['validateConfig bad type', () => service.handlers.validateConfig({ text: 42 })],
        [
          'validateConfig oversized text',
          () => service.handlers.validateConfig({ text: 'a'.repeat(MAX_CONFIG_BYTES + 1) }),
        ],
        ['confirmDeleteServer unsafe', () => service.handlers.confirmDeleteServer({ name: '' })],
        ['copyEndpoint bad type', () => service.handlers.copyEndpoint({ name: null })],
        [
          'copyClientConfig bad redact',
          () => service.handlers.copyClientConfig({ name: 'alpha', redact: 'yes' }),
        ],
        [
          'copyClientConfig unsafe name',
          () => service.handlers.copyClientConfig({ name: '../x', redact: true }),
        ],
        ['openSocialLink bad target', () => service.handlers.openSocialLink({ target: 'evil' })],
        [
          'importExternalServers bad rev',
          () => service.handlers.importExternalServers({ expectedRevision: 'xyz' }),
        ],
        [
          'updatesSetAutomatic bad type',
          () => service.handlers.updatesSetAutomatic({ automatic: 'true' }),
        ],
        ['setLanguage bad type', () => service.handlers.setLanguage({ preference: 123 })],
        ['setLanguage unknown locale', () => service.handlers.setLanguage({ preference: 'ja_JP' })],
      ];

    for (const [label, invoke] of invalidCases) {
      const result = await invoke();
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.error?.code, label).toBe('InvalidRequest');
      }
    }
    expect(calls.recordedErrors).toEqual([]);
  });

  test('rejects non-empty parameters on all parameterless handlers', async () => {
    const { service } = createServiceHarness();
    const extra = { unexpected: true };

    const results = await Promise.all([
      service.handlers.clearLogs(extra),
      service.handlers.snapshot(extra),
      service.handlers.quit(extra),
      service.handlers.quitStatus(extra),
      service.handlers.start(extra),
      service.handlers.stop(extra),
      service.handlers.dismissKeyReminder(extra),
      service.handlers.confirmDiscard(extra),
      service.handlers.revealConfig(extra),
      service.handlers.openConfigInEditor(extra),
      service.handlers.dismissWhatsNew(extra),
      service.handlers.updatesCheck(extra),
      service.handlers.updatesDownload(extra),
      service.handlers.updatesInstall(extra),
      service.handlers.updatesRestart(extra),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('InvalidRequest');
        expect(result.error.message).toBe('This operation does not accept parameters.');
      }
    }
  });

  test('preserves GatewayError details without recording local errors, and sanitizes unexpected errors', async () => {
    const { service, hooks, calls } = createServiceHarness();

    const gwError = failure('ConfigLocked', 'Configuration is locked by another process.');
    hooks.setStart(() => {
      throw gwError;
    });
    const gwResult = await service.handlers.start();
    expect(gwResult).toEqual({
      ok: false,
      error: {
        code: 'ConfigLocked',
        message: 'Configuration is locked by another process.',
        occurrenceId: gwError.occurrenceId,
      },
    });
    expect(calls.recordedErrors).toEqual([]);

    const rawError = new Error('SQLITE_BUSY: sensitive secret=abc123');
    hooks.setStart(() => {
      throw rawError;
    });
    const unexpectedResult = await service.handlers.start();
    expect(unexpectedResult.ok).toBe(false);
    if (!unexpectedResult.ok) {
      expect(unexpectedResult.error.code).toBe('OperationFailed');
      expect(unexpectedResult.error.message).toBe(
        'The application operation failed. Open Logs for details.',
      );
      expect(unexpectedResult.error.occurrenceId).toMatch(/^request-\d+$/);
      expect(unexpectedResult.error.message).not.toContain('abc123');
    }
    expect(calls.recordedErrors).toEqual([rawError]);
  });
});

describe('AppService — assertIdle guards during quit and update restart', () => {
  test('rejects all guarded handlers when quit phase is not idle', async () => {
    const { service, setQuitStatus, calls } = createServiceHarness();
    setQuitStatus({ attempt: 1, phase: 'pending', error: null });

    const guardedResults = await Promise.all([
      service.handlers.testServer({ name: 'alpha', expectedRevision: VALID_REVISION }),
      service.handlers.saveConfig({ text: '{}', expectedRevision: VALID_REVISION }),
      service.handlers.migrateKeys({
        gateway: true,
        servers: [],
        expectedRevision: VALID_REVISION,
      }),
      service.handlers.validateConfig({ text: '{}' }),
      service.handlers.openSocialLink({ target: 'docs' }),
      service.handlers.revealConfig(),
      service.handlers.openConfigInEditor(),
      service.handlers.importExternalServers({ expectedRevision: VALID_REVISION }),
      service.handlers.setLanguage({ preference: 'fr_FR' }),
    ]);

    for (const result of guardedResults) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('InvalidRequest');
        expect(result.error.message).toContain('Quit cleanup has started.');
      }
    }

    expect(calls.saveConfigCalls).toHaveLength(0);
    expect(calls.migrateKeysCalls).toHaveLength(0);
    expect(calls.testServerCalls).toHaveLength(0);
    expect(calls.openedExternal).toHaveLength(0);
    expect(calls.setLanguageCalls).toHaveLength(0);
  });

  test('rejects guarded handlers when update phase is restarting', async () => {
    const { service, setUpdateStatus } = createServiceHarness();
    setUpdateStatus(makeUpdateStatus({ phase: 'restarting' }));

    const results = await Promise.all([
      service.handlers.saveConfig({ text: '{}', expectedRevision: VALID_REVISION }),
      service.handlers.migrateKeys({
        gateway: true,
        servers: [],
        expectedRevision: VALID_REVISION,
      }),
      service.handlers.importExternalServers({ expectedRevision: VALID_REVISION }),
      service.handlers.testServer({ name: 'alpha', expectedRevision: VALID_REVISION }),
      service.handlers.setLanguage({ preference: 'de_DE' }),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('InvalidRequest');
        expect(result.error.message).toContain('Quit cleanup has started.');
      }
    }
  });

  test('snapshot caches loginStatus once quit cleanup starts instead of querying native login library', async () => {
    const { service, setQuitStatus, setLoginStatus, calls } = createServiceHarness({
      loginStatus: { enabled: true, supported: true, error: null },
    });
    const beforeCalls = calls.loginStatusCalls;

    setQuitStatus({ attempt: 1, phase: 'pending', error: null });
    setLoginStatus({ enabled: false, supported: false, error: 'released' });

    const snap = await service.handlers.snapshot();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.value.login).toEqual({ enabled: true, supported: true, error: null });
    }
    expect(calls.loginStatusCalls).toBe(beforeCalls);
  });
});

describe('AppService — gateway, server control, logs, and lifecycle RPCs', () => {
  test('currentSnapshot, snapshot, start, stop, restartServer, readLogs, clearLogs, and testServer delegate cleanly', async () => {
    const { service, setLogPage, setTestServerResult, calls } = createServiceHarness({
      keyMigration: { gateway: true, servers: [] },
      keyReminderRetired: false,
    });

    const directSnap = service.currentSnapshot();
    expect(directSnap.keyReminder).toBe(true);
    expect(directSnap.whatsNew).toBe('0.9.0');
    expect(directSnap.language.locale).toBe('en_US');

    const rpcSnap = await service.handlers.snapshot();
    expect(rpcSnap.ok).toBe(true);
    if (rpcSnap.ok) expect(rpcSnap.value.gateway.revision).toBe(VALID_REVISION);

    const startRes = await service.handlers.start();
    expect(startRes.ok).toBe(true);
    expect(calls.startCalls).toHaveLength(1);
    expect(calls.startCalls[0]?.signal).toBeInstanceOf(AbortSignal);

    const stopRes = await service.handlers.stop();
    expect(stopRes.ok).toBe(true);
    expect(calls.stopCalls).toBe(1);
    if (stopRes.ok) expect(stopRes.value.gateway.running).toBe(false);

    const restartRes = await service.handlers.restartServer({ name: 'alpha' });
    expect(restartRes.ok).toBe(true);
    expect(calls.restartServerCalls).toHaveLength(1);
    expect(calls.restartServerCalls[0]?.name).toBe('alpha');

    const page: LogPage = {
      entries: [
        {
          id: 1,
          time: '2026-11-27T00:00:00Z',
          server: 'alpha',
          level: 'info',
          source: 'controller',
          text: 'started',
          truncated: false,
        },
      ],
      cursor: 1,
      generation: 1,
      gap: false,
      hasMore: false,
    };
    setLogPage(page);
    const logsRes = await service.handlers.readLogs({ after: 0 });
    expect(logsRes).toEqual({ ok: true, value: page });
    expect(calls.readLogsCalls).toEqual([{ after: 0 }]);

    const clearRes = await service.handlers.clearLogs();
    expect(clearRes.ok).toBe(true);
    expect(calls.clearLogsCalls).toBe(1);

    setTestServerResult({ protocolVersion: '2025-11-25' });
    const testRes = await service.handlers.testServer({
      name: 'alpha',
      expectedRevision: VALID_REVISION,
    });
    expect(testRes).toEqual({ ok: true, value: { protocolVersion: '2025-11-25' } });
    expect(calls.testServerCalls).toEqual([{ name: 'alpha', expectedRevision: VALID_REVISION }]);

    const staleTestRes = await service.handlers.testServer({
      name: 'alpha',
      expectedRevision: OTHER_REVISION,
    });
    expect(staleTestRes.ok).toBe(false);
    if (!staleTestRes.ok) expect(staleTestRes.error.code).toBe('StaleRevision');
  });

  test('lifecycle RPCs (stop, snapshot) do not block behind a queued saveConfig operation', async () => {
    const { service, hooks } = createServiceHarness();
    const gate = deferred();
    hooks.setSaveConfig(async () => {
      await gate.promise;
    });

    const pendingSave = service.handlers.saveConfig({
      text: makeConfigText(),
      expectedRevision: VALID_REVISION,
    });

    const stopResult = await service.handlers.stop();
    expect(stopResult.ok).toBe(true);

    gate.resolve();
    const saveResult = await pendingSave;
    expect(saveResult.ok).toBe(true);
  });

  test('validateConfig previews valid and invalid configuration text without queueing', async () => {
    const { service } = createServiceHarness();

    const valid = await service.handlers.validateConfig({ text: makeConfigText() });
    expect(valid).toEqual({ ok: true, value: { issue: null } });

    const invalid = await service.handlers.validateConfig({ text: '{ not valid json' });
    expect(invalid.ok).toBe(true);
    if (invalid.ok) {
      expect(invalid.value.issue).not.toBeNull();
    }
  });

  test('confirmDiscard, confirmDeleteServer, quit, and quitStatus delegate to desktop actions', async () => {
    const { service, setConfirmDiscardResult, setConfirmDeleteResult, calls } =
      createServiceHarness();

    setConfirmDiscardResult(false);
    expect(await service.handlers.confirmDiscard()).toEqual({ ok: true, value: false });
    expect(calls.confirmDiscardCalls).toBe(1);

    setConfirmDeleteResult(true);
    expect(await service.handlers.confirmDeleteServer({ name: 'alpha' })).toEqual({
      ok: true,
      value: true,
    });
    expect(calls.confirmDeleteCalls).toEqual(['alpha']);

    expect(await service.handlers.quitStatus()).toEqual({
      ok: true,
      value: { attempt: 0, phase: 'idle', error: null },
    });

    const quitRes = await service.handlers.quit();
    expect(quitRes).toEqual({
      ok: true,
      value: { requested: true, status: { attempt: 1, phase: 'pending', error: null } },
    });
    expect(calls.requestQuitCalls).toBe(1);

    expect(await service.handlers.quitStatus()).toEqual({
      ok: true,
      value: { attempt: 1, phase: 'pending', error: null },
    });
  });
});

describe('AppService — saveConfig & launchAtLogin synchronization', () => {
  test('syncs launchAtLogin when setting changes and surfaces login warning without rolling back config', async () => {
    const { service, setActiveConfig, hooks, calls } = createServiceHarness({
      loginStatus: { enabled: false, supported: true, error: null },
    });

    const nextConfig: GatewayConfig = {
      ...BASE_CONFIG,
      gateway: { ...BASE_CONFIG.gateway, launchAtLogin: true },
    };
    hooks.setSaveConfig(() => {
      setActiveConfig(nextConfig);
    });
    hooks.setLoginSetEnabled(() => ({
      enabled: false,
      supported: true,
      error: 'Login item registration requires approval.',
    }));

    const result = await service.handlers.saveConfig({
      text: makeConfigText(nextConfig),
      expectedRevision: VALID_REVISION,
    });

    expect(calls.saveConfigCalls).toHaveLength(1);
    expect(calls.loginSetCalls).toEqual([true]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.login.error).toBe('Login item registration requires approval.');
      expect(result.value.gateway.configText).toContain('"launchAtLogin": true');
    }
  });

  test('retries login registration when launchAtLogin is unchanged but needsLoginRetry is true', async () => {
    const enabledConfig: GatewayConfig = {
      ...BASE_CONFIG,
      gateway: { ...BASE_CONFIG.gateway, launchAtLogin: true },
    };
    const { service, calls } = createServiceHarness({
      activeConfig: enabledConfig,
      loginStatus: { enabled: false, supported: true, error: 'Previous attempt failed' },
    });

    const result = await service.handlers.saveConfig({
      text: makeConfigText(enabledConfig),
      expectedRevision: VALID_REVISION,
    });

    expect(result.ok).toBe(true);
    expect(calls.loginSetCalls).toEqual([true]);
    if (result.ok) {
      expect(result.value.login).toEqual({ enabled: true, supported: true, error: null });
    }
  });

  test('does not touch macOS login registration if saveConfig fails or quit starts mid-save', async () => {
    const { service, hooks, setQuitStatus, setActiveConfig, calls } = createServiceHarness();

    hooks.setSaveConfig(() => {
      throw failure('StaleRevision', 'Revision changed.');
    });
    const failedSave = await service.handlers.saveConfig({
      text: makeConfigText(),
      expectedRevision: VALID_REVISION,
    });
    expect(failedSave.ok).toBe(false);
    expect(calls.loginSetCalls).toEqual([]);

    const nextConfig: GatewayConfig = {
      ...BASE_CONFIG,
      gateway: { ...BASE_CONFIG.gateway, launchAtLogin: true },
    };
    hooks.setSaveConfig(() => {
      setActiveConfig(nextConfig);
      setQuitStatus({ attempt: 1, phase: 'pending', error: null });
    });
    const quittingSave = await service.handlers.saveConfig({
      text: makeConfigText(nextConfig),
      expectedRevision: VALID_REVISION,
    });
    expect(quittingSave.ok).toBe(true);
    expect(calls.loginSetCalls).toEqual([]);
  });

  test('skips login registration when unsupported and unchanged, but attempts when transitioning false -> true', async () => {
    const { service, setActiveConfig, hooks, calls } = createServiceHarness({
      loginStatus: { enabled: false, supported: false, error: null },
    });

    await service.handlers.saveConfig({
      text: makeConfigText(),
      expectedRevision: VALID_REVISION,
    });
    expect(calls.loginSetCalls).toEqual([]);

    const nextConfig: GatewayConfig = {
      ...BASE_CONFIG,
      gateway: { ...BASE_CONFIG.gateway, launchAtLogin: true },
    };
    hooks.setSaveConfig(() => {
      setActiveConfig(nextConfig);
    });
    await service.handlers.saveConfig({
      text: makeConfigText(nextConfig),
      expectedRevision: VALID_REVISION,
    });
    expect(calls.loginSetCalls).toEqual([true]);
  });
});

describe('AppService — keychain migration & key reminder RPCs', () => {
  test('migrateKeys retires reminder, delegates to controller, and updates snapshot', async () => {
    const { service, calls } = createServiceHarness({
      keyMigration: { gateway: true, servers: ['alpha'] },
      keyReminderRetired: false,
    });

    const res = await service.handlers.migrateKeys({
      gateway: true,
      servers: ['alpha'],
      expectedRevision: VALID_REVISION,
    });

    expect(res.ok).toBe(true);
    expect(calls.retireKeyReminderCalls).toBe(1);
    expect(calls.migrateKeysCalls).toHaveLength(1);
    expect(calls.migrateKeysCalls[0]?.slots).toEqual({ gateway: true, servers: ['alpha'] });
    if (res.ok) {
      expect(res.value.keyReminder).toBe(false);
      expect(res.value.gateway.keyMigration).toEqual({ gateway: false, servers: [] });
    }
  });

  test('migrateKeys records retireKeyReminder error and still migrates keys', async () => {
    const { service, hooks, calls } = createServiceHarness({
      keyMigration: { gateway: true, servers: [] },
    });
    const retireErr = new Error('disk full');
    hooks.setRetireKeyReminder(() => {
      throw retireErr;
    });

    const res = await service.handlers.migrateKeys({
      gateway: true,
      servers: [],
      expectedRevision: VALID_REVISION,
    });

    expect(res.ok).toBe(true);
    expect(calls.recordedErrors).toEqual([retireErr]);
    expect(calls.migrateKeysCalls).toHaveLength(1);
  });

  test('dismissKeyReminder retires reminder and refreshes snapshot', async () => {
    const { service, calls } = createServiceHarness({
      keyMigration: { gateway: true, servers: [] },
      keyReminderRetired: false,
    });

    expect(service.currentSnapshot().keyReminder).toBe(true);
    const res = await service.handlers.dismissKeyReminder();
    expect(res.ok).toBe(true);
    expect(calls.retireKeyReminderCalls).toBe(1);
    if (res.ok) expect(res.value.keyReminder).toBe(false);
  });
});

describe('AppService — client config, clipboard, social links, and file actions', () => {
  test('copyEndpoint copies server endpoint and rejects unknown server', async () => {
    const { service, calls } = createServiceHarness();

    const ok = await service.handlers.copyEndpoint({ name: 'alpha' });
    expect(ok).toEqual({ ok: true, value: null });
    expect(calls.copiedTexts).toEqual(['http://127.0.0.1:3333/mcp/alpha']);

    const missing = await service.handlers.copyEndpoint({ name: 'nonexistent' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('InvalidRequest');
  });

  test('copyClientConfig supports redact true/false, falls back to gateway token, and refuses on configError', async () => {
    const { service, setSnapshot, setActiveConfig, calls } = createServiceHarness();

    const redacted = await service.handlers.copyClientConfig({ name: 'alpha', redact: true });
    expect(redacted).toEqual({ ok: true, value: null });
    expect(JSON.parse(calls.copiedTexts[0] ?? '')).toEqual({
      mcpServers: {
        alpha: {
          url: 'http://127.0.0.1:3333/mcp/alpha',
          headers: { Authorization: 'Bearer [REDACTED]' },
        },
      },
    });
    expect(calls.copiedTexts[0]).not.toContain('do-not-leak');
    expect(calls.copiedTexts[0]).not.toContain(SERVER_TOKEN);

    const live = await service.handlers.copyClientConfig({ name: 'alpha', redact: false });
    expect(live).toEqual({ ok: true, value: null });
    expect(JSON.parse(calls.copiedTexts[1] ?? '')).toEqual({
      mcpServers: {
        alpha: {
          url: 'http://127.0.0.1:3333/mcp/alpha',
          headers: { Authorization: `Bearer ${SERVER_TOKEN}` },
        },
      },
    });

    const inherited = await service.handlers.copyClientConfig({ name: 'beta' });
    expect(inherited).toEqual({ ok: true, value: null });
    expect(JSON.parse(calls.copiedTexts[2] ?? '')).toEqual({
      mcpServers: {
        beta: {
          url: 'http://127.0.0.1:3333/mcp/beta',
          headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
        },
      },
    });
    expect(calls.copiedTexts[2]).not.toContain('X-Upstream-Secret');

    setSnapshot({
      configError: { code: 'InvalidConfig', message: 'broken', occurrenceId: 'issue-1' },
    });
    const onError = await service.handlers.copyClientConfig({ name: 'alpha' });
    expect(onError.ok).toBe(false);
    if (!onError.ok) expect(onError.error.code).toBe('InvalidRequest');

    setSnapshot({ configError: null });
    setActiveConfig(undefined);
    const noActive = await service.handlers.copyClientConfig({ name: 'alpha' });
    expect(noActive.ok).toBe(false);
    if (!noActive.ok) expect(noActive.error.code).toBe('InvalidRequest');
  });

  test('openSocialLink opens allowlisted URLs and rejects when browser fails to open', async () => {
    const { service, setOpenExternalResult, calls } = createServiceHarness();

    expect(await service.handlers.openSocialLink({ target: 'docs' })).toEqual({
      ok: true,
      value: null,
    });
    expect(await service.handlers.openSocialLink({ target: 'github' })).toEqual({
      ok: true,
      value: null,
    });
    expect(await service.handlers.openSocialLink({ target: 'x' })).toEqual({
      ok: true,
      value: null,
    });
    expect(calls.openedExternal).toEqual([
      'https://github.com/zaherg/mcp-gateway/blob/main/docs/README.md',
      'https://github.com/zaherg/mcp-gateway',
      'https://x.com/zaherg',
    ]);

    setOpenExternalResult(false);
    const fail = await service.handlers.openSocialLink({ target: 'github' });
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.error.code).toBe('InvalidRequest');
  });

  test('revealConfig reveals existing mcp.json or falls back to parent directory when missing', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'mcp.json');
    const { service, setOpenPathResult, calls } = createServiceHarness({ configPath });

    const missingRes = await service.handlers.revealConfig();
    expect(missingRes).toEqual({ ok: true, value: null });
    expect(calls.openedPaths).toEqual([dirname(configPath)]);
    expect(calls.shownInFolder).toEqual([]);

    setOpenPathResult(false);
    const fallbackFail = await service.handlers.revealConfig();
    expect(fallbackFail.ok).toBe(false);
    if (!fallbackFail.ok) expect(fallbackFail.error.code).toBe('InvalidRequest');

    await writeFile(configPath, '{}', 'utf8');
    const presentRes = await service.handlers.revealConfig();
    expect(presentRes).toEqual({ ok: true, value: null });
    expect(calls.shownInFolder).toEqual([configPath]);
  });

  test('openConfigInEditor opens plain file and refuses symlinks and directories with UnsafeFile', async () => {
    const dir = await makeTempDir();
    const realFile = join(dir, 'real.json');
    const linkFile = join(dir, 'link.json');
    await writeFile(realFile, '{}', 'utf8');
    await symlink(realFile, linkFile);

    const { service, setSnapshot, setOpenPathResult, calls } = createServiceHarness({
      configPath: realFile,
    });

    const ok = await service.handlers.openConfigInEditor();
    expect(ok).toEqual({ ok: true, value: null });
    expect(calls.openedPaths).toEqual([realFile]);

    setOpenPathResult(false);
    const openFail = await service.handlers.openConfigInEditor();
    expect(openFail.ok).toBe(false);
    if (!openFail.ok) expect(openFail.error.code).toBe('InvalidRequest');

    setOpenPathResult(true);
    setSnapshot({ configPath: linkFile });
    const symlinkRes = await service.handlers.openConfigInEditor();
    expect(symlinkRes.ok).toBe(false);
    if (!symlinkRes.ok) {
      expect(symlinkRes.error.code).toBe('UnsafeFile');
      expect(symlinkRes.error.message).toBe('Symlinked configuration files are refused.');
    }

    setSnapshot({ configPath: dir });
    const dirRes = await service.handlers.openConfigInEditor();
    expect(dirRes.ok).toBe(false);
    if (!dirRes.ok) expect(dirRes.error.code).toBe('UnsafeFile');
  });
});

describe('AppService — importExternalServers security filtering & deduplication', () => {
  test('imports valid Claude Desktop and Cursor servers while filtering unsafe entries and duplicates', async () => {
    const fakeHome = await makeTempDir('mcp-gateway-fake-home-');
    trackSpy(spyOn(os, 'homedir').mockReturnValue(fakeHome));

    const claudeDir = join(fakeHome, 'Library', 'Application Support', 'Claude');
    const cursorDir = join(fakeHome, '.cursor');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });

    await writeFile(
      join(claudeDir, 'claude_desktop_config.json'),
      JSON.stringify({
        mcpServers: {
          good_stdio: {
            command: '/usr/local/bin/mcp-server',
            args: ['--port', '9000'],
            env: { SAFE_FLAG: '1' },
            cwd: '/tmp',
            disabled: false,
          },
          alpha: {
            command: '/usr/bin/should-be-skipped',
          },
          shared_name: {
            command: '/usr/bin/from-claude',
          },
          bad_dyld: {
            command: '/usr/bin/env',
            env: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' },
          },
          bad_ld: {
            command: '/usr/bin/env',
            env: { LD_PRELOAD: '/tmp/evil.so' },
          },
          bad_node_opts: {
            command: '/usr/bin/env',
            env: { NODE_OPTIONS: '--require /tmp/evil.js' },
          },
          bad_bun_opts: {
            command: '/usr/bin/env',
            env: { BUN_OPTIONS: '--preload /tmp/evil.js' },
          },
          bad_cwd: {
            command: '/usr/bin/env',
            cwd: 'relative/path',
          },
          ambiguous: {
            command: '/usr/bin/env',
            url: 'https://example.com/mcp',
          },
          '../escape': {
            command: '/usr/bin/env',
          },
        },
      }),
      'utf8',
    );

    await writeFile(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          good_http: {
            url: 'https://api.example.com/mcp',
            headers: { 'X-Custom': 'ok' },
            disabled: true,
          },
          shared_name: {
            command: '/usr/bin/from-cursor',
          },
          self_loopback: {
            url: 'http://127.0.0.1:3333/mcp/alpha',
          },
          self_localhost: {
            url: 'http://localhost:3333/mcp/other',
          },
          link_local_v4: {
            url: 'http://169.254.169.254/latest/meta-data',
          },
          link_local_v6: {
            url: 'http://[fe80::1]/mcp',
          },
          unspecified_v4: {
            url: 'http://0.0.0.0:8080/mcp',
          },
          with_userinfo: {
            url: 'https://user:pass@example.com/mcp',
          },
          with_hash: {
            url: 'https://example.com/mcp#frag',
          },
          file_scheme: {
            url: 'file:///etc/passwd',
          },
          bad_host_header: {
            url: 'https://api.example.com/mcp',
            headers: { Host: 'spoofed.example.com' },
          },
          bad_proxy_header: {
            url: 'https://api.example.com/mcp',
            headers: { 'Proxy-Authorization': 'Basic abc' },
          },
          bad_session_header: {
            url: 'https://api.example.com/mcp',
            headers: { 'Mcp-Session-Id': 'fixed' },
          },
        },
      }),
      'utf8',
    );

    const { service, calls } = createServiceHarness();
    const res = await service.handlers.importExternalServers({ expectedRevision: VALID_REVISION });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.importedCount).toBe(3);
    expect(calls.saveConfigCalls).toHaveLength(1);

    const saved = JSON.parse(calls.saveConfigCalls[0]?.text ?? '{}') as GatewayConfig;
    expect(Object.keys(saved.mcpServers).sort()).toEqual([
      'alpha',
      'beta',
      'good_http',
      'good_stdio',
      'shared_name',
    ]);
    expect(saved.mcpServers.good_stdio).toEqual({
      command: '/usr/local/bin/mcp-server',
      args: ['--port', '9000'],
      env: { SAFE_FLAG: '1' },
      cwd: '/tmp',
      disabled: false,
    });
    expect(saved.mcpServers.good_http).toEqual({
      url: 'https://api.example.com/mcp',
      headers: { 'X-Custom': 'ok' },
      disabled: true,
    });
    expect(saved.mcpServers.shared_name).toEqual({ command: '/usr/bin/from-claude' });
  });

  test('skips symlinked external config files, enforces 64-server cap, and skips save when nothing imported', async () => {
    const fakeHome = await makeTempDir('mcp-gateway-fake-home-cap-');
    trackSpy(spyOn(os, 'homedir').mockReturnValue(fakeHome));

    const claudeDir = join(fakeHome, 'Library', 'Application Support', 'Claude');
    const cursorDir = join(fakeHome, '.cursor');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });

    const realTarget = join(fakeHome, 'real-claude.json');
    await writeFile(
      realTarget,
      JSON.stringify({ mcpServers: { from_symlink: { command: '/usr/bin/true' } } }),
      'utf8',
    );
    await symlink(realTarget, join(claudeDir, 'claude_desktop_config.json'));

    const noImportHarness = createServiceHarness();
    const noImportRes = await noImportHarness.service.handlers.importExternalServers({
      expectedRevision: VALID_REVISION,
    });
    expect(noImportRes.ok).toBe(true);
    if (noImportRes.ok) expect(noImportRes.value.importedCount).toBe(0);
    expect(noImportHarness.calls.saveConfigCalls).toHaveLength(0);

    const manyServers: Record<string, { command: string }> = {};
    for (let i = 0; i < 70; i++) {
      manyServers[`srv_${i}`] = { command: '/usr/bin/true' };
    }
    await writeFile(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({ mcpServers: manyServers }),
      'utf8',
    );

    const capHarness = createServiceHarness();
    const capRes = await capHarness.service.handlers.importExternalServers({
      expectedRevision: VALID_REVISION,
    });
    expect(capRes.ok).toBe(true);
    if (capRes.ok) expect(capRes.value.importedCount).toBe(62);
    const saved = JSON.parse(capHarness.calls.saveConfigCalls[0]?.text ?? '{}') as GatewayConfig;
    expect(Object.keys(saved.mcpServers)).toHaveLength(64);
    expect(saved.mcpServers.from_symlink).toBeUndefined();

    const staleRes = await capHarness.service.handlers.importExternalServers({
      expectedRevision: OTHER_REVISION,
    });
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) expect(staleRes.error.code).toBe('StaleRevision');
  });
});

describe('AppService — localization, whatsNew, and updater RPC delegation', () => {
  test('setLanguage updates LanguageStore via desktop action and returns updated snapshot', async () => {
    const { service, calls } = createServiceHarness();

    const fr = await service.handlers.setLanguage({ preference: 'fr_FR' });
    expect(fr.ok).toBe(true);
    expect(calls.setLanguageCalls).toEqual(['fr_FR']);
    if (fr.ok) {
      expect(fr.value.language.preference).toBe('fr_FR');
      expect(fr.value.language.locale).toBe('fr_FR');
    }

    const sys = await service.handlers.setLanguage({ preference: 'system' });
    expect(sys.ok).toBe(true);
    if (sys.ok) {
      expect(sys.value.language.preference).toBe('system');
      expect(sys.value.language.locale).toBe('en_US');
    }
  });

  test('dismissWhatsNew and all updater RPC handlers delegate to desktop/updates runtimes', async () => {
    const { service, calls } = createServiceHarness({ whatsNew: '0.9.0' });

    const dismissed = await service.handlers.dismissWhatsNew();
    expect(dismissed).toEqual({ ok: true, value: null });
    expect(calls.dismissWhatsNewCalls).toBe(1);
    expect(service.currentSnapshot().whatsNew).toBeNull();

    const checked = await service.handlers.updatesCheck();
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.phase).toBe('available');
    expect(calls.updatesCheckCalls).toBe(1);

    const downloaded = await service.handlers.updatesDownload();
    expect(downloaded.ok).toBe(true);
    if (downloaded.ok) expect(downloaded.value.phase).toBe('downloading');
    expect(calls.updatesDownloadCalls).toBe(1);

    const installed = await service.handlers.updatesInstall();
    expect(installed.ok).toBe(true);
    if (installed.ok) expect(installed.value.phase).toBe('ready');
    expect(calls.updatesInstallCalls).toBe(1);

    const autoOff = await service.handlers.updatesSetAutomatic({ automatic: false });
    expect(autoOff.ok).toBe(true);
    if (autoOff.ok) expect(autoOff.value.automaticUpdates).toBe(false);
    expect(calls.updatesSetAutomaticCalls).toEqual([false]);

    const restarted = await service.handlers.updatesRestart();
    expect(restarted).toEqual({
      ok: true,
      value: { requested: true, status: { attempt: 1, phase: 'pending', error: null } },
    });
    expect(calls.updatesRestartCalls).toBe(1);
  });
});

describe('app-updater — support resolution & verification helpers', () => {
  test('resolveUpdateSupport requires stable channel, strict semver version, and non-empty baseUrl', async () => {
    sdkState.localInfo = {
      version: '0.9.0',
      hash: 'abc1234',
      baseUrl: 'https://updates.example.com',
      channel: 'stable',
      name: 'Bear MCP Gateway',
      identifier: 'com.zaherg.mcp-gateway',
    };
    expect(await resolveUpdateSupport()).toEqual({ supported: true, installedVersion: '0.9.0' });

    sdkState.localInfo = { ...sdkState.localInfo, channel: 'dev' };
    expect(await resolveUpdateSupport()).toEqual({ supported: false, installedVersion: '0.9.0' });

    sdkState.localInfo = { ...sdkState.localInfo, channel: 'stable', version: '0.9.0-rc.1' };
    expect(await resolveUpdateSupport()).toEqual({ supported: false, installedVersion: null });

    sdkState.localInfo = { ...sdkState.localInfo, version: '0.9.0', baseUrl: '' };
    expect(await resolveUpdateSupport()).toEqual({ supported: false, installedVersion: '0.9.0' });
  });

  test('verifyStagedAppBundleSignature validates codesign verification and TeamIdentifier match', async () => {
    const dir = await makeTempDir('mcp-gateway-codesign-');
    const stagedApp = join(dir, 'Staged.app');
    const installedApp = join(dir, 'Installed.app');
    await mkdir(stagedApp);
    await mkdir(installedApp);

    const runSpy = trackSpy(spyOn(processModule, 'runCommand'));

    runSpy.mockImplementation(async (_cmd, args) => {
      if (args.includes('--verify')) return { stdout: '', stderr: 'valid on disk', exitCode: 0 };
      return { stdout: '', stderr: 'TeamIdentifier=TEAM123456\n', exitCode: 0 };
    });
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).resolves.toBeUndefined();
    expect(runSpy).toHaveBeenCalledTimes(3);

    runSpy.mockClear();
    runSpy.mockImplementation(async (_cmd, args) => {
      if (args.includes('--verify')) return { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes(stagedApp))
        return { stdout: '', stderr: 'TeamIdentifier=OTHER99999\n', exitCode: 0 };
      return { stdout: '', stderr: 'TeamIdentifier=TEAM123456\n', exitCode: 0 };
    });
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).rejects.toThrow(
      'Staged update signing TeamIdentifier does not match the installed app.',
    );

    runSpy.mockResolvedValue({ stdout: '', stderr: 'invalid signature', exitCode: 1 });
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).rejects.toThrow(
      'Staged update failed codesign integrity verification.',
    );

    runSpy.mockImplementation(async (_cmd, args) =>
      args.includes('--verify')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'cannot read', exitCode: 1 },
    );
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).rejects.toThrow(
      'Could not inspect staged update signing identity.',
    );
  });

  test('verifyDownloadedUpdate validates v2 integrity manifest and staged bundle signature', async () => {
    const appDataDir = await makeTempDir('mcp-gateway-updater-data-');
    const stagedApp = join(appDataDir, 'Staged.app');
    await mkdir(stagedApp);
    const selfExtraction = join(appDataDir, 'self-extraction');
    await mkdir(selfExtraction, { recursive: true });
    await writeFile(
      join(selfExtraction, '.electrobun-prepared-update.json'),
      JSON.stringify({ staging_path: stagedApp }),
      'utf8',
    );
    sdkState.appDataFolder = appDataDir;

    const validManifest = {
      schemaVersion: 1,
      identifier: 'com.zaherg.mcp-gateway',
      channel: 'stable',
      version: '0.10.0',
      hash: 'def5678',
      artifact: { tarSha256: VALID_SHA256, tarSize: 1024 },
    };

    const fetchSpy = mockFetchWith(
      async () =>
        new Response(JSON.stringify(validManifest), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const runSpy = trackSpy(
      spyOn(processModule, 'runCommand').mockResolvedValue({
        stdout: '',
        stderr: 'TeamIdentifier=not set\n',
        exitCode: 0,
      }),
    );

    await expect(
      verifyDownloadedUpdate({ version: '0.10.0', hash: 'def5678' }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://updates.example.com/stable-macos-arm64-update-v2.json',
    );
    expect(runSpy).toHaveBeenCalled();

    fetchSpy.mockResolvedValueOnce(new Response('fail', { status: 503 }));
    await expect(verifyDownloadedUpdate({ version: '0.10.0', hash: 'def5678' })).rejects.toThrow(
      'Update integrity manifest check failed (HTTP 503).',
    );

    fetchSpy.mockResolvedValueOnce(new Response('{bad json', { status: 200 }));
    await expect(verifyDownloadedUpdate({ version: '0.10.0', hash: 'def5678' })).rejects.toThrow(
      'Update integrity manifest contains invalid JSON.',
    );

    fetchSpy.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    await expect(verifyDownloadedUpdate({ version: '0.10.0', hash: 'def5678' })).rejects.toThrow(
      'Update integrity manifest must be an object.',
    );

    for (const badManifest of [
      { ...validManifest, schemaVersion: 2 },
      { ...validManifest, identifier: 'com.other.app' },
      { ...validManifest, channel: 'dev' },
      { ...validManifest, version: '0.9.9' },
      { ...validManifest, hash: 'wronghash' },
      { ...validManifest, artifact: { tarSha256: 'not-hex', tarSize: 1024 } },
      { ...validManifest, artifact: { tarSha256: VALID_SHA256, tarSize: 0 } },
    ]) {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(badManifest), { status: 200 }));
      await expect(verifyDownloadedUpdate({ version: '0.10.0', hash: 'def5678' })).rejects.toThrow(
        'Downloaded update failed integrity manifest verification.',
      );
    }

    sdkState.appDataFolder = '';
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(
      verifyDownloadedUpdate({ version: '0.10.0', hash: 'def5678' }),
    ).resolves.toBeUndefined();
  });
});

describe('AppUpdater — updates.json preference persistence (Plan 036, SEC-10)', () => {
  test('defaults to automaticUpdates=true when missing and loads valid updates.json cleanly', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-prefs-');
    const { coordinator } = makeQuitCoordinator();

    const first = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: coordinator,
      }),
    );
    const missingStatus = await first.start();
    expect(missingStatus.automaticUpdates).toBe(true);
    expect(missingStatus.phase).toBe('idle');
    expect(missingStatus.error).toBeNull();
    first.stop();

    const prefPath = join(dir, 'updates.json');
    await writeFile(prefPath, JSON.stringify({ schema_version: 1, automaticUpdates: false }), {
      mode: 0o600,
    });
    await chmod(prefPath, 0o600);

    const second = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: coordinator,
      }),
    );
    const loadedStatus = await second.start();
    expect(loadedStatus.automaticUpdates).toBe(false);
    expect(loadedStatus.phase).toBe('idle');
    expect(loadedStatus.error).toBeNull();
  });

  test('corrupted, extra-key, symlinked, or world-writable updates.json surfaces PREFERENCE_ERROR and disables auto-check', async () => {
    const cases: Array<{
      name: string;
      prepare: (dir: string, prefPath: string) => Promise<void>;
    }> = [
      {
        name: 'corrupted JSON',
        prepare: async (_dir, prefPath) => {
          await writeFile(prefPath, '{broken', { mode: 0o600 });
          await chmod(prefPath, 0o600);
        },
      },
      {
        name: 'extra unexpected key',
        prepare: async (_dir, prefPath) => {
          await writeFile(
            prefPath,
            JSON.stringify({ schema_version: 1, automaticUpdates: true, extra: true }),
            { mode: 0o600 },
          );
          await chmod(prefPath, 0o600);
        },
      },
      {
        name: 'wrong key name',
        prepare: async (_dir, prefPath) => {
          await writeFile(prefPath, JSON.stringify({ schema_version: 1, autoCheck: true }), {
            mode: 0o600,
          });
          await chmod(prefPath, 0o600);
        },
      },
      {
        name: 'symlinked updates.json',
        prepare: async (dir, prefPath) => {
          const target = join(dir, 'real-updates.json');
          await writeFile(target, JSON.stringify({ schema_version: 1, automaticUpdates: true }), {
            mode: 0o600,
          });
          await chmod(target, 0o600);
          await symlink(target, prefPath);
        },
      },
      {
        name: 'world-writable updates.json',
        prepare: async (_dir, prefPath) => {
          await writeFile(prefPath, JSON.stringify({ schema_version: 1, automaticUpdates: true }), {
            mode: 0o600,
          });
          await chmod(prefPath, 0o666);
        },
      },
    ];

    for (const testCase of cases) {
      const dir = await makeTempDir('mcp-gateway-updater-badpref-');
      await testCase.prepare(dir, join(dir, 'updates.json'));
      const setTimeoutSpy = trackSpy(spyOn(globalThis, 'setTimeout'));
      const { coordinator } = makeQuitCoordinator();

      const updater = trackUpdater(
        new AppUpdater({
          dataDirectory: dir,
          supported: true,
          installedVersion: '0.9.0',
          quit: coordinator,
        }),
      );
      const status = await updater.start();

      expect(status.automaticUpdates, testCase.name).toBe(false);
      expect(status.phase, testCase.name).toBe('error');
      expect(status.error, testCase.name).toBe(PREFERENCE_ERROR);
      expect(setTimeoutSpy, testCase.name).not.toHaveBeenCalled();

      updater.stop();
      setTimeoutSpy.mockRestore();
    }
  });

  test('setAutomatic writes 0o600 updates.json, clears timers & PREFERENCE_ERROR, and preserves state if write fails', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-write-');
    const prefPath = join(dir, 'updates.json');
    await writeFile(prefPath, '{invalid', { mode: 0o600 });
    await chmod(prefPath, 0o600);

    const { coordinator } = makeQuitCoordinator();
    const updater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: coordinator,
      }),
    );

    const initial = await updater.start();
    expect(initial.error).toBe(PREFERENCE_ERROR);
    expect(initial.phase).toBe('error');

    const enabled = await updater.setAutomatic(true);
    expect(enabled.automaticUpdates).toBe(true);
    expect(enabled.error).toBeNull();
    expect(enabled.phase).toBe('idle');

    const modeAfterEnable = (await stat(prefPath)).mode & 0o777;
    expect(modeAfterEnable).toBe(0o600);
    expect(JSON.parse(await readFile(prefPath, 'utf8'))).toEqual({
      schema_version: 1,
      automaticUpdates: true,
    });

    const clearTimeoutSpy = trackSpy(spyOn(globalThis, 'clearTimeout'));
    await chmod(dir, 0o500);
    lockedDirs.push(dir);
    await expect(updater.setAutomatic(false)).rejects.toThrow();
    expect(updater.status().automaticUpdates).toBe(true);
    expect(clearTimeoutSpy).not.toHaveBeenCalled();

    await chmod(dir, 0o700);
    const disabled = await updater.setAutomatic(false);
    expect(disabled.automaticUpdates).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect((await stat(prefPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(prefPath, 'utf8'))).toEqual({
      schema_version: 1,
      automaticUpdates: false,
    });
  });
});

describe('AppUpdater — unsupported mode & stopped lifecycle guards', () => {
  test('reports unsupported status cleanly without touching SDK or network and rejects mutating operations', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-unsupported-');
    const fetchSpy = mockFetchWith(async () => {
      throw new Error('network should not be called');
    });
    const { coordinator } = makeQuitCoordinator();

    const updater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: false,
        installedVersion: null,
        quit: coordinator,
      }),
    );

    const status = await updater.start();
    expect(status.supported).toBe(false);
    expect(status.automaticUpdates).toBe(false);
    expect(status.phase).toBe('idle');
    expect(sdkState.onStatusChangeCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    for (const action of [
      () => updater.check(),
      () => updater.download(),
      () => updater.installUpdate(),
      () => updater.setAutomatic(true),
      () => updater.restart(),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(RequestError);
      await expect(action()).rejects.toThrow('Updates are unavailable in this build.');
    }
  });

  test('stop() unsubscribes SDK listener, clears subscribers, and rejects subsequent operations', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-stop-');
    const { coordinator } = makeQuitCoordinator();
    const updater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: coordinator,
      }),
    );

    const seen: UpdateStatus[] = [];
    updater.subscribe((status) => seen.push(status));
    await updater.start();
    expect(seen.length).toBeGreaterThan(0);

    updater.stop();
    expect(sdkState.onStatusChangeCalls.at(-1)).toBeNull();
    await expect(updater.check()).rejects.toThrow(
      'Update work is unavailable after shutdown has started.',
    );
    await expect(updater.setAutomatic(false)).rejects.toThrow(
      'Update work is unavailable after shutdown has started.',
    );
  });
});

describe('AppUpdater — state transitions, progress, restart, and error sanitization', () => {
  test('check() transitions idle -> checking -> idle/available/error and sanitizes secret URLs (SEC-14)', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-check-');
    const prefPath = join(dir, 'updates.json');
    await writeFile(prefPath, JSON.stringify({ schema_version: 1, automaticUpdates: false }), {
      mode: 0o600,
    });
    await chmod(prefPath, 0o600);

    const { coordinator } = makeQuitCoordinator();
    const updater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: coordinator,
      }),
    );
    await updater.start();

    const phases: string[] = [];
    updater.subscribe((s) => phases.push(s.phase));

    sdkState.checkForUpdateImpl = async () => ({
      version: '0.9.0',
      hash: 'abc1234',
      updateAvailable: false,
      updateReady: false,
      error: '',
    });
    const upToDate = await updater.check();
    expect(upToDate.phase).toBe('idle');
    expect(upToDate.availableVersion).toBeNull();
    expect(upToDate.checkedAt).not.toBeNull();
    expect(phases).toEqual(['checking', 'idle']);

    sdkState.checkForUpdateImpl = async () => ({
      version: '0.8.9',
      hash: 'old1234',
      updateAvailable: true,
      updateReady: false,
      error: '',
    });
    const ineligible = await updater.check();
    expect(ineligible.phase).toBe('error');
    expect(ineligible.availableVersion).toBeNull();
    expect(ineligible.error).toBe('The offered update version is not eligible.');

    phases.length = 0;
    sdkState.checkForUpdateImpl = async () => ({
      version: '0.10.0',
      hash: 'def5678',
      updateAvailable: true,
      updateReady: false,
      error: '',
    });
    const available = await updater.check();
    expect(available.phase).toBe('available');
    expect(available.availableVersion).toBe('0.10.0');
    expect(phases).toEqual(['checking', 'available']);

    sdkState.checkForUpdateImpl = async () => {
      throw new Error(
        'Failed https://admin:topsecret@updates.example.com/feed?token=leak123 Authorization: Bearer tok_secret',
      );
    };
    const errored = await updater.check();
    expect(errored.phase).toBe('error');
    expect(errored.error).not.toContain('topsecret');
    expect(errored.error).not.toContain('leak123');
    expect(errored.error).not.toContain('tok_secret');
    expect(errored.error).toContain('://[REDACTED]@');
    expect(errored.error).toContain('token=[REDACTED]');
    expect(errored.error).toContain('Bearer [REDACTED]');
  });

  test('download() tracks SDK download progress and transitions to ready after integrity verification', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-download-');
    const prefPath = join(dir, 'updates.json');
    await writeFile(prefPath, JSON.stringify({ schema_version: 1, automaticUpdates: false }), {
      mode: 0o600,
    });
    await chmod(prefPath, 0o600);

    mockFetchWith(async () => new Response('not found', { status: 404 }));

    const { coordinator } = makeQuitCoordinator();
    const updater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: coordinator,
      }),
    );
    await updater.start();

    await expect(updater.download()).rejects.toThrow(
      'No eligible update is available to download.',
    );

    sdkState.checkForUpdateImpl = async () => ({
      version: '0.10.0',
      hash: 'def5678',
      updateAvailable: true,
      updateReady: false,
      error: '',
    });
    await updater.check();

    const gate = deferred();
    const snapshots: UpdateStatus[] = [];
    updater.subscribe((s) => snapshots.push(s));

    sdkState.downloadUpdateImpl = async () => {
      sdkState.statusListener?.({
        status: 'download-progress',
        message: 'Downloading',
        timestamp: Date.now(),
        details: { bytesDownloaded: 500, totalBytes: 1000 },
      });
      await gate.promise;
      sdkState.updateInfo = {
        version: '0.10.0',
        hash: 'def5678',
        updateAvailable: true,
        updateReady: true,
        error: '',
      };
    };

    const started = await updater.download();
    expect(started.phase).toBe('downloading');

    expect(updater.status().progressPercent).toBe(50);
    expect(updater.status().downloadedBytes).toBe(500);
    expect(updater.status().totalBytes).toBe(1000);

    expect((await updater.download()).phase).toBe('downloading');

    gate.resolve();
    await flushMicrotasks();

    const ready = updater.status();
    expect(ready.phase).toBe('ready');
    expect(ready.availableVersion).toBe('0.10.0');
    expect(ready.progressPercent).toBe(100);
    expect(snapshots.some((s) => s.phase === 'downloading' && s.progressPercent === 50)).toBe(true);
    expect(snapshots.some((s) => s.phase === 'ready' && s.progressPercent === 100)).toBe(true);
  });

  test('restart() verifies update, coordinates quit lifecycle, and handles both success and handoff failure', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-restart-');
    const prefPath = join(dir, 'updates.json');
    await writeFile(prefPath, JSON.stringify({ schema_version: 1, automaticUpdates: false }), {
      mode: 0o600,
    });
    await chmod(prefPath, 0o600);

    mockFetchWith(async () => new Response('not found', { status: 404 }));

    let cleanupCount = 0;
    const { coordinator: okCoordinator, failures: okFailures } = makeQuitCoordinator(async () => {
      cleanupCount++;
    });
    const okUpdater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: okCoordinator,
      }),
    );
    await okUpdater.start();

    await expect(okUpdater.restart()).rejects.toThrow('No verified update is ready to install.');

    sdkState.updateInfo = {
      version: '0.10.0',
      hash: 'def5678',
      updateAvailable: true,
      updateReady: true,
      error: '',
    };
    sdkState.applyUpdateImpl = async () => {
      expect(okCoordinator.updateRestartActive()).toBe(true);
      sdkState.statusHistory.push({
        status: 'launching-new-version',
        message: 'Launching 0.10.0',
        timestamp: Date.now(),
      });
    };

    const restartStatus = await okUpdater.restart();
    expect(cleanupCount).toBe(1);
    expect(restartStatus.phase).toBe('pending');
    expect(okCoordinator.updateRestartActive()).toBe(false);
    expect(okFailures).toEqual([]);
    expect(okUpdater.status().phase).toBe('restarting');
    okUpdater.stop();

    const { coordinator: failCoordinator, failures: failFailures } = makeQuitCoordinator();
    const failUpdater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: failCoordinator,
      }),
    );
    await failUpdater.start();

    sdkState.statusHistory = [];
    sdkState.applyUpdateImpl = async () => {
      throw new Error('helper binary missing');
    };

    const failedQuitStatus = await failUpdater.restart();
    expect(failedQuitStatus.phase).toBe('failed');
    expect(failedQuitStatus.error).toContain('Update handoff failed.');
    expect(failUpdater.status().phase).toBe('error');
    expect(failUpdater.status().error).toBe('helper binary missing');
    expect(failFailures).toHaveLength(1);
    expect(failFailures[0]?.kind).toBe('update');
    failUpdater.stop();

    const { coordinator: quitCoordinator } = makeQuitCoordinator();
    quitCoordinator.armQuit();
    const blockedUpdater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: quitCoordinator,
      }),
    );
    await blockedUpdater.start();
    await expect(blockedUpdater.restart()).rejects.toThrow(
      'Quit cleanup has started. Retry Quit to close the app.',
    );
  });

  test('installUpdate() downloads and restarts from available, and seedFromSdk() restores ready state on start', async () => {
    const dir = await makeTempDir('mcp-gateway-updater-install-');
    const prefPath = join(dir, 'updates.json');
    await writeFile(prefPath, JSON.stringify({ schema_version: 1, automaticUpdates: false }), {
      mode: 0o600,
    });
    await chmod(prefPath, 0o600);

    mockFetchWith(async () => new Response('not found', { status: 404 }));

    sdkState.updateInfo = {
      version: '0.10.0',
      hash: 'def5678',
      updateAvailable: true,
      updateReady: true,
      error: '',
    };
    let applyCalls = 0;
    sdkState.applyUpdateImpl = async () => {
      applyCalls++;
      sdkState.statusHistory.push({
        status: 'launching-new-version',
        message: 'Launching',
        timestamp: Date.now(),
      });
    };

    const { coordinator } = makeQuitCoordinator();
    const updater = trackUpdater(
      new AppUpdater({
        dataDirectory: dir,
        supported: true,
        installedVersion: '0.9.0',
        quit: coordinator,
      }),
    );
    const seeded = await updater.start();
    expect(seeded.phase).toBe('ready');
    expect(seeded.availableVersion).toBe('0.10.0');
    expect(seeded.progressPercent).toBe(100);

    const installed = await updater.installUpdate();
    expect(applyCalls).toBe(1);
    expect(installed.phase).toBe('restarting');
  });
});
