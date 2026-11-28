import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';

import type { Updater, UpdateStatusEntry } from 'electrobun/main';

import { failure, RequestError } from '@mcp-gateway/core/errors';
import * as processModule from '@mcp-gateway/core/process';
import type { UpdateRuntime } from '@mcp-gateway/main/app-updater';
import { QuitCoordinator } from '@mcp-gateway/main/lifecycle';
import { AppService, type LoginManager } from '@mcp-gateway/main/service';
import { MAX_CONFIG_BYTES } from '@mcp-gateway/shared/config-document';
import { CATALOG_LOCALES, type LanguagePreference, languageState } from '@mcp-gateway/shared/i18n';
import type {
  AppearancePreference,
  LoginStatus,
  QuitStatus,
  UpdateStatus,
} from '@mcp-gateway/shared/rpc';
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
import { deferred, flushMicrotasks, registerTempDirLifecycle } from '../helpers/core';

type LocalUpdateInfo = Awaited<ReturnType<typeof Updater.getLocalInfo>>;
type UpdateInfo = ReturnType<typeof Updater.updateInfo>;

const makeUpdateInfo = (overrides: Partial<UpdateInfo> = {}) => ({
  version: '',
  hash: '',
  updateAvailable: false,
  updateReady: false,
  error: '',
  ...overrides,
});
const availInfo = (version = '0.10.0', hash = 'def5678') =>
  makeUpdateInfo({ version, hash, updateAvailable: true });
const readyInfo = (version = '0.10.0', hash = 'def5678') =>
  makeUpdateInfo({ version, hash, updateAvailable: true, updateReady: true });

const defaultSdkState = () => ({
  localInfo: {
    version: '0.9.0',
    hash: 'abc1234',
    baseUrl: 'https://updates.example.com',
    channel: 'stable',
    name: 'Bear MCP Gateway',
    identifier: 'com.zaherg.mcp-gateway',
  } as LocalUpdateInfo,
  updateInfo: makeUpdateInfo(),
  statusHistory: [] as UpdateStatusEntry[],
  statusListener: null as ((entry: UpdateStatusEntry) => void) | null,
  onStatusChangeCalls: [] as Array<((entry: UpdateStatusEntry) => void) | null>,
  appDataFolder: '',
  checkForUpdateImpl: async (): Promise<UpdateInfo> => sdkState.updateInfo,
  downloadUpdateImpl: async () => {},
  applyUpdateImpl: async () => {},
});

let sdkState = defaultSdkState();
const emitSdkStatus = (
  status: UpdateStatusEntry['status'],
  extra: Partial<UpdateStatusEntry> = {},
) => sdkState.statusListener?.({ status, message: status, timestamp: Date.now(), ...extra });

mock.module('electrobun/main', () => ({
  Updater: {
    getLocalInfo: async () => sdkState.localInfo,
    updateInfo: () => sdkState.updateInfo,
    getStatusHistory: () => [...sdkState.statusHistory],
    onStatusChange: (cb: ((entry: UpdateStatusEntry) => void) | null) => {
      sdkState.onStatusChangeCalls.push(cb);
      sdkState.statusListener = cb;
    },
    checkForUpdate: async () => sdkState.checkForUpdateImpl(),
    downloadUpdate: async () => sdkState.downloadUpdateImpl(),
    applyUpdate: async () => sdkState.applyUpdateImpl(),
    appDataFolder: async () => sdkState.appDataFolder,
  },
}));

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

const makeConfigText = (config = BASE_CONFIG) => `${JSON.stringify(config, null, 2)}\n`;
const withLoginConfig = () => ({
  ...BASE_CONFIG,
  gateway: { ...BASE_CONFIG.gateway, launchAtLogin: true },
});
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

const { makeTempDir } = registerTempDirLifecycle('mcp-gateway-service-test-');
const activeSpies: Array<{ mockRestore(): void }> = [];
const activeUpdaters: Array<InstanceType<typeof AppUpdater>> = [];
const trackSpy = <T extends { mockRestore(): void }>(spy: T) => {
  activeSpies.push(spy);
  return spy;
};
const trackUpdater = (u: InstanceType<typeof AppUpdater>) => {
  activeUpdaters.push(u);
  return u;
};

type HarnessOpts = Partial<{
  configPath: string;
  configText: string;
  revision: string;
  activeConfig: GatewayConfig | undefined;
  configError: GatewaySnapshot['configError'];
  keyMigration: KeyMigration;
  loginStatus: LoginStatus;
  quitStatus: QuitStatus;
  updateStatus: UpdateStatus;
  whatsNew: string | null;
  keyReminderRetired: boolean;
}>;

const createServiceHarness = (options: HarnessOpts = {}) => {
  const activeConfig =
    'activeConfig' in options ? options.activeConfig : structuredClone(BASE_CONFIG);
  const mkServer = (name: string, type: 'stdio' | 'http') => ({
    name,
    type,
    endpoint: `http://127.0.0.1:3333/mcp/${name}`,
    enabled: true,
    status: 'mounted' as const,
    error: null,
  });
  const state = {
    activeConfig,
    snapshot: {
      configPath: options.configPath ?? '/tmp/nonexistent-mcp-gateway/mcp.json',
      configFormat: 'json',
      configText: options.configText ?? makeConfigText(activeConfig ?? BASE_CONFIG),
      revision: options.revision ?? VALID_REVISION,
      running: true,
      interfaces: [{ name: 'lo0', address: '127.0.0.1', netmask: '255.0.0.0', kind: 'loopback' }],
      network: 'loopback',
      keyMigration: options.keyMigration ?? { gateway: false, servers: [] },
      servers: [mkServer('alpha', 'stdio'), mkServer('beta', 'http')],
      configError: options.configError ?? null,
      operationalError: null,
    } as GatewaySnapshot,
    loginStatus: options.loginStatus ?? { enabled: false, supported: true, error: null },
    quitStatus: options.quitStatus ?? ({ attempt: 0, phase: 'idle', error: null } as QuitStatus),
    updateStatus: options.updateStatus ?? makeUpdateStatus(),
    whatsNew: options.whatsNew !== undefined ? options.whatsNew : '0.9.0',
    keyReminderRetired: options.keyReminderRetired ?? false,
    language: languageState('system', 'en_US', [...CATALOG_LOCALES]),
    appearance: 'system' as AppearancePreference,
    logPage: { entries: [], cursor: 0, generation: 1, gap: false, hasMore: false } as LogPage,
    testServerResult: { protocolVersion: '2025-11-25' } as ServerCheckResult,
  };

  const setSnap = (patch: Partial<GatewaySnapshot>) => {
    state.snapshot = { ...state.snapshot, ...patch };
    return state.snapshot;
  };
  const controller = {
    readLogs: mock((_query: LogQuery) => state.logPage),
    clearLogs: mock(() => ({ ...state.logPage, entries: [], cursor: 0, generation: 2 })),
    recordLocalError: mock((_error: unknown) => {}),
    snapshot: mock(() => state.snapshot),
    operation: mock(() => ({ signal: new AbortController().signal })),
    start: mock(async (_op?: GatewayOperation) => setSnap({ running: true })),
    stop: mock(async () => setSnap({ running: false })),
    testServer: mock(async (_name: string, _rev: string) => state.testServerResult),
    saveConfig: mock(async (configText: string, _rev: string, _op?: GatewayOperation) =>
      setSnap({ configText }),
    ),
    migrateKeys: mock(async (slots: KeyMigration, _rev: string, _op?: GatewayOperation) => {
      const prev = state.snapshot.keyMigration;
      return setSnap({
        keyMigration: {
          gateway: slots.gateway ? false : prev.gateway,
          servers: prev.servers.filter((s) => !slots.servers.includes(s)),
        },
      });
    }),
    activeConfig: mock(() => state.activeConfig),
    close: mock(async () => {}),
  } satisfies GatewayController;

  const login = {
    status: mock(() => state.loginStatus),
    setEnabled: mock((enabled: boolean) => {
      state.loginStatus = { ...state.loginStatus, enabled, error: null };
      return state.loginStatus;
    }),
  } satisfies LoginManager;

  const desktop = {
    requestQuit: mock(() => {
      state.quitStatus = { attempt: state.quitStatus.attempt + 1, phase: 'pending', error: null };
      return state.quitStatus;
    }),
    quitStatus: mock(() => state.quitStatus),
    openExternal: mock((_url: string) => true),
    showItemInFolder: mock((_path: string) => {}),
    openPath: mock((_path: string) => true),
    confirmDiscard: mock(async () => true),
    confirmDeleteServer: mock(async (_name: string) => true),
    whatsNew: mock(() => state.whatsNew),
    dismissWhatsNew: mock(async () => {
      state.whatsNew = null;
    }),
    keyReminderRetired: mock(() => state.keyReminderRetired),
    retireKeyReminder: mock(async () => {
      state.keyReminderRetired = true;
    }),
    language: mock(() => state.language),
    setLanguage: mock(async (preference: LanguagePreference) => {
      state.language = languageState(preference, state.language.system, state.language.available);
    }),
    appearance: mock(() => state.appearance),
    setAppearance: mock(async (preference: AppearancePreference) => {
      state.appearance = preference;
    }),
  };

  const setUpdate = (patch: Partial<UpdateStatus>) => {
    state.updateStatus = { ...state.updateStatus, ...patch };
    return state.updateStatus;
  };
  const updates = {
    status: mock(() => state.updateStatus),
    check: mock(async () => setUpdate({ phase: 'available', availableVersion: '0.10.0' })),
    download: mock(async () => setUpdate({ phase: 'downloading' })),
    installUpdate: mock(async () => setUpdate({ phase: 'ready', availableVersion: '0.10.0' })),
    setAutomatic: mock(async (enabled: boolean) => setUpdate({ automaticUpdates: enabled })),
    restart: mock(async (): Promise<QuitStatus> => ({ attempt: 1, phase: 'pending', error: null })),
    start: mock(async () => state.updateStatus),
    stop: mock(() => {}),
    subscribe: mock(() => () => {}),
  } satisfies UpdateRuntime;

  const copyText = mock((_text: string) => {});
  const service = new AppService(controller, login, copyText, desktop, updates);
  return { service, state, controller, login, desktop, updates, copyText };
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
  while (activeUpdaters.length > 0) activeUpdaters.pop()?.stop();
  while (activeSpies.length > 0) activeSpies.pop()?.mockRestore();
});

describe('AppService — RPC parameter validation & error sanitization', () => {
  test('rejects invalid payloads, rejects parameters on parameterless handlers, preserves GatewayError, and sanitizes unexpected errors', async () => {
    const { service, controller } = createServiceHarness();
    const h = service.handlers;
    const huge = 'x'.repeat(MAX_CONFIG_BYTES + 1);
    const rev = VALID_REVISION;

    for (const invoke of [
      () => h.readLogs('bad'),
      () => h.readLogs({ after: -1 }),
      () => h.readLogs({ after: 1.5 }),
      () => h.readLogs({ after: Number.NaN }),
      () => h.readLogs({ after: 0, extra: 1 }),
      () => h.testServer({ name: 'alpha' }),
      () => h.testServer({ name: 'alpha', expectedRevision: 'bad' }),
      () => h.testServer({ name: 'a/b', expectedRevision: rev }),
      () => h.saveConfig({ expectedRevision: rev }),
      () => h.saveConfig({ text: '{}', expectedRevision: 'short' }),
      () => h.saveConfig({ text: huge, expectedRevision: rev }),
      () => h.migrateKeys({ gateway: false, servers: [], expectedRevision: rev }),
      () => h.migrateKeys({ gateway: true, servers: [], expectedRevision: '12' }),
      () => h.migrateKeys({ gateway: false, servers: ['a', 'a'], expectedRevision: rev }),
      () => h.migrateKeys({ gateway: false, servers: ['a b'], expectedRevision: rev }),
      () => h.validateConfig({ text: 42 }),
      () => h.validateConfig({ text: huge }),
      () => h.confirmDeleteServer({ name: '' }),
      () => h.copyEndpoint({ name: null }),
      () => h.copyClientConfig({ name: 'alpha', redact: 'yes' }),
      () => h.copyClientConfig({ name: '../x', redact: true }),
      () => h.openSocialLink({ target: 'evil' }),
      () => h.importExternalServers({ expectedRevision: 'xyz' }),
      () => h.updatesSetAutomatic({ automatic: 'true' }),
      () => h.setLanguage({ preference: 123 }),
      () => h.setLanguage({ preference: 'ja_JP' }),
      () => h.setAppearance({ preference: 123 }),
      () => h.setAppearance({ preference: 'sepia' }),
    ]) {
      const result = await invoke();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error?.code).toBe('InvalidRequest');
    }

    const extra = { unexpected: true };
    const noParamResults = await Promise.all([
      h.clearLogs(extra),
      h.snapshot(extra),
      h.quit(extra),
      h.quitStatus(extra),
      h.start(extra),
      h.stop(extra),
      h.dismissKeyReminder(extra),
      h.confirmDiscard(extra),
      h.revealConfig(extra),
      h.openConfigInEditor(extra),
      h.dismissWhatsNew(extra),
      h.updatesCheck(extra),
      h.updatesDownload(extra),
      h.updatesInstall(extra),
      h.updatesRestart(extra),
    ]);
    for (const result of noParamResults) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'InvalidRequest', message: 'This operation does not accept parameters.' },
      });
    }
    expect(controller.recordLocalError).not.toHaveBeenCalled();

    const gwError = failure('ConfigLocked', 'Configuration is locked by another process.');
    controller.start.mockImplementationOnce(async () => {
      throw gwError;
    });
    expect(await h.start()).toEqual({
      ok: false,
      error: {
        code: 'ConfigLocked',
        message: 'Configuration is locked by another process.',
        occurrenceId: gwError.occurrenceId,
      },
    });
    expect(controller.recordLocalError).not.toHaveBeenCalled();

    const rawError = new Error('SQLITE_BUSY: sensitive secret=abc123');
    controller.start.mockImplementationOnce(async () => {
      throw rawError;
    });
    const res = await h.start();
    expect(!res.ok && res.error).toMatchObject({
      code: 'OperationFailed',
      message: 'The application operation failed. Open Logs for details.',
    });
    if (!res.ok) {
      expect(res.error.occurrenceId).toMatch(/^request-\d+$/);
      expect(res.error.message).not.toContain('abc123');
    }
    expect(controller.recordLocalError.mock.calls).toEqual([[rawError]]);
  });
});

describe('AppService — assertIdle guards, gateway control, logs, and lifecycle RPCs', () => {
  test('rejects guarded mutation handlers when quit phase is not idle or update phase is restarting, and caches loginStatus during quit', async () => {
    const { service, state, controller, desktop, login } = createServiceHarness({
      loginStatus: { enabled: true, supported: true, error: null },
    });
    const h = service.handlers;

    for (const [quitPhase, updatePhase] of [
      ['pending', 'idle'],
      ['idle', 'restarting'],
    ] as const) {
      state.quitStatus = { attempt: 1, phase: quitPhase, error: null };
      state.updateStatus = makeUpdateStatus({ phase: updatePhase });

      const guardedResults = await Promise.all([
        h.testServer({ name: 'alpha', expectedRevision: VALID_REVISION }),
        h.saveConfig({ text: '{}', expectedRevision: VALID_REVISION }),
        h.migrateKeys({ gateway: true, servers: [], expectedRevision: VALID_REVISION }),
        h.validateConfig({ text: '{}' }),
        h.openSocialLink({ target: 'docs' }),
        h.revealConfig(),
        h.openConfigInEditor(),
        h.importExternalServers({ expectedRevision: VALID_REVISION }),
        h.setLanguage({ preference: 'fr_FR' }),
        h.setAppearance({ preference: 'light' }),
      ]);

      for (const result of guardedResults) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('InvalidRequest');
          expect(result.error.message).toContain('Quit cleanup has started.');
        }
      }
    }

    expect(controller.saveConfig).not.toHaveBeenCalled();
    expect(controller.migrateKeys).not.toHaveBeenCalled();
    expect(controller.testServer).not.toHaveBeenCalled();
    expect(desktop.openExternal).not.toHaveBeenCalled();
    expect(desktop.setLanguage).not.toHaveBeenCalled();
    expect(desktop.setAppearance).not.toHaveBeenCalled();

    const beforeCalls = login.status.mock.calls.length;
    state.quitStatus = { attempt: 1, phase: 'pending', error: null };
    state.loginStatus = { enabled: false, supported: false, error: 'released' };
    const snap = await h.snapshot();
    expect(snap.ok && snap.value.login).toEqual({ enabled: true, supported: true, error: null });
    expect(login.status.mock.calls.length).toBe(beforeCalls);
  });

  test('delegates all gateway, log, server, desktop, and update RPCs and does not block stop/validateConfig behind saveConfig', async () => {
    const { service, state, controller, desktop, updates } = createServiceHarness({
      keyMigration: { gateway: true, servers: [] },
      keyReminderRetired: false,
    });
    const h = service.handlers;

    expect(service.currentSnapshot()).toMatchObject({
      keyReminder: true,
      whatsNew: '0.9.0',
      language: { locale: 'en_US' },
    });

    const rpcSnap = await h.snapshot();
    expect(rpcSnap.ok && rpcSnap.value.gateway.revision).toBe(VALID_REVISION);
    expect((await h.start()).ok).toBe(true);
    expect(controller.start.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    const stopRes = await h.stop();
    expect(stopRes.ok && stopRes.value.gateway.running).toBe(false);

    const page = { entries: [], cursor: 1, generation: 1, gap: false, hasMore: false };
    state.logPage = page;
    expect(await h.readLogs({ after: 0 })).toEqual({ ok: true, value: page });
    expect(controller.readLogs.mock.calls).toEqual([[{ after: 0 }]]);
    expect((await h.clearLogs()).ok).toBe(true);

    expect(await h.testServer({ name: 'alpha', expectedRevision: VALID_REVISION })).toEqual({
      ok: true,
      value: { protocolVersion: '2025-11-25' },
    });
    const staleTestRes = await h.testServer({ name: 'alpha', expectedRevision: OTHER_REVISION });
    expect(!staleTestRes.ok && staleTestRes.error.code).toBe('StaleRevision');

    desktop.confirmDiscard.mockResolvedValueOnce(false);
    expect(await h.confirmDiscard()).toEqual({ ok: true, value: false });
    expect(await h.confirmDeleteServer({ name: 'alpha' })).toEqual({ ok: true, value: true });
    expect(desktop.confirmDeleteServer.mock.calls).toEqual([['alpha']]);
    expect(await h.dismissWhatsNew()).toEqual({ ok: true, value: null });
    expect(service.currentSnapshot().whatsNew).toBeNull();

    const fr = await h.setLanguage({ preference: 'fr_FR' });
    expect(fr.ok && fr.value.language).toMatchObject({ preference: 'fr_FR', locale: 'fr_FR' });
    const light = await h.setAppearance({ preference: 'light' });
    expect(light.ok && light.value.appearance).toBe('light');
    const dark = await h.setAppearance({ preference: 'dark' });
    expect(dark.ok && dark.value.appearance).toBe('dark');
    const sys = await h.setLanguage({ preference: 'system' });
    expect(sys.ok && sys.value.language).toMatchObject({ preference: 'system', locale: 'en_US' });

    const gate = deferred();
    controller.saveConfig.mockImplementationOnce(async () => {
      await gate.promise;
      return controller.snapshot();
    });
    const pendingSave = h.saveConfig({ text: makeConfigText(), expectedRevision: VALID_REVISION });
    expect((await h.stop()).ok).toBe(true);
    expect(await h.validateConfig({ text: makeConfigText() })).toEqual({
      ok: true,
      value: { issue: null },
    });
    const invalid = await h.validateConfig({ text: '{ not valid json' });
    expect(invalid.ok && invalid.value.issue).not.toBeNull();
    gate.resolve();
    expect((await pendingSave).ok).toBe(true);

    expect((await h.updatesCheck()).ok).toBe(true);
    expect((await h.updatesDownload()).ok).toBe(true);
    expect((await h.updatesInstall()).ok).toBe(true);
    expect((await h.updatesSetAutomatic({ automatic: false })).ok).toBe(true);
    expect(updates.setAutomatic.mock.calls).toEqual([[false]]);
    const pendingQuit = { attempt: 1, phase: 'pending', error: null } as const;
    expect(await h.updatesRestart()).toEqual({
      ok: true,
      value: { requested: true, status: pendingQuit },
    });
    expect(await h.quitStatus()).toEqual({
      ok: true,
      value: { attempt: 0, phase: 'idle', error: null },
    });
    expect(await h.quit()).toEqual({ ok: true, value: { requested: true, status: pendingQuit } });
  });
});

describe('AppService — saveConfig, launchAtLogin, keychain migration, and file actions', () => {
  const saveCfg = (service: AppService, config = BASE_CONFIG) =>
    service.handlers.saveConfig({ text: makeConfigText(config), expectedRevision: VALID_REVISION });

  test('syncs launchAtLogin on change, surfaces login warning without rolling back config, retries on needsLoginRetry, and skips on failed/quitting/unchanged saves', async () => {
    const { service, state, controller, login } = createServiceHarness({
      loginStatus: { enabled: false, supported: true, error: null },
    });
    const nextConfig = withLoginConfig();
    controller.saveConfig.mockImplementationOnce(async (configText) => {
      state.activeConfig = nextConfig;
      state.snapshot = { ...state.snapshot, configText };
      return state.snapshot;
    });
    login.setEnabled.mockImplementationOnce(() => {
      state.loginStatus = {
        enabled: false,
        supported: true,
        error: 'Login item registration requires approval.',
      };
      return state.loginStatus;
    });

    const result = await saveCfg(service, nextConfig);
    expect(login.setEnabled.mock.calls).toEqual([[true]]);
    expect(result.ok && result.value.login.error).toBe(
      'Login item registration requires approval.',
    );
    expect(result.ok && result.value.gateway.configText).toContain('"launchAtLogin": true');

    const retryHarness = createServiceHarness({
      activeConfig: nextConfig,
      loginStatus: { enabled: false, supported: true, error: 'Previous attempt failed' },
    });
    const retried = await saveCfg(retryHarness.service, nextConfig);
    expect(retryHarness.login.setEnabled.mock.calls).toEqual([[true]]);
    expect(retried.ok && retried.value.login).toEqual({
      enabled: true,
      supported: true,
      error: null,
    });

    const skip = createServiceHarness();
    skip.controller.saveConfig.mockImplementationOnce(async () => {
      throw failure('StaleRevision', 'Revision changed.');
    });
    expect((await saveCfg(skip.service)).ok).toBe(false);
    expect(skip.login.setEnabled).not.toHaveBeenCalled();

    skip.controller.saveConfig.mockImplementationOnce(async (configText) => {
      skip.state.activeConfig = nextConfig;
      skip.state.quitStatus = { attempt: 1, phase: 'pending', error: null };
      skip.state.snapshot = { ...skip.state.snapshot, configText };
      return skip.state.snapshot;
    });
    expect((await saveCfg(skip.service, nextConfig)).ok).toBe(true);
    expect(skip.login.setEnabled).not.toHaveBeenCalled();

    const unsup = createServiceHarness({
      loginStatus: { enabled: false, supported: false, error: null },
    });
    await saveCfg(unsup.service);
    expect(unsup.login.setEnabled).not.toHaveBeenCalled();
    unsup.controller.saveConfig.mockImplementationOnce(async (configText) => {
      unsup.state.activeConfig = nextConfig;
      unsup.state.snapshot = { ...unsup.state.snapshot, configText };
      return unsup.state.snapshot;
    });
    await saveCfg(unsup.service, nextConfig);
    expect(unsup.login.setEnabled.mock.calls).toEqual([[true]]);
  });

  test('migrateKeys, dismissKeyReminder, copyEndpoint, copyClientConfig, openSocialLink, revealConfig, and openConfigInEditor enforce security and redaction', async () => {
    const { service, state, controller, desktop, copyText } = createServiceHarness({
      keyMigration: { gateway: true, servers: ['alpha'] },
      keyReminderRetired: false,
    });
    const h = service.handlers;
    const migrateArgs = { gateway: true, servers: ['alpha'], expectedRevision: VALID_REVISION };
    const res = await h.migrateKeys(migrateArgs);
    expect(desktop.retireKeyReminder).toHaveBeenCalledTimes(1);
    expect(controller.migrateKeys.mock.calls[0]?.[0]).toEqual({
      gateway: true,
      servers: ['alpha'],
    });
    expect(res.ok && res.value).toMatchObject({
      keyReminder: false,
      gateway: { keyMigration: { gateway: false, servers: [] } },
    });

    const errHarness = createServiceHarness({ keyMigration: { gateway: true, servers: [] } });
    const retireErr = new Error('disk full');
    errHarness.desktop.retireKeyReminder.mockImplementationOnce(async () => {
      throw retireErr;
    });
    const gwMigrate = { gateway: true, servers: [], expectedRevision: VALID_REVISION };
    expect((await errHarness.service.handlers.migrateKeys(gwMigrate)).ok).toBe(true);
    expect(errHarness.controller.recordLocalError.mock.calls).toEqual([[retireErr]]);

    const dismissHarness = createServiceHarness({
      keyMigration: { gateway: true, servers: [] },
      keyReminderRetired: false,
    });
    expect(dismissHarness.service.currentSnapshot().keyReminder).toBe(true);
    const dismissed = await dismissHarness.service.handlers.dismissKeyReminder();
    expect(dismissed.ok && dismissed.value.keyReminder).toBe(false);

    const expectedClient = (name: string, token: string) => ({
      mcpServers: {
        [name]: {
          url: `http://127.0.0.1:3333/mcp/${name}`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });

    expect((await h.copyEndpoint({ name: 'alpha' })).ok).toBe(true);
    expect(copyText.mock.calls).toEqual([['http://127.0.0.1:3333/mcp/alpha']]);
    expect((await h.copyEndpoint({ name: 'nonexistent' })).ok).toBe(false);

    copyText.mockClear();
    expect((await h.copyClientConfig({ name: 'alpha', redact: true })).ok).toBe(true);
    const call0 = copyText.mock.calls[0]?.[0] ?? '';
    expect(JSON.parse(call0)).toEqual(expectedClient('alpha', '[REDACTED]'));
    expect(call0).not.toContain('do-not-leak');
    expect(call0).not.toContain(SERVER_TOKEN);

    expect((await h.copyClientConfig({ name: 'alpha', redact: false })).ok).toBe(true);
    const call1 = copyText.mock.calls[1]?.[0] ?? '';
    expect(JSON.parse(call1)).toEqual(expectedClient('alpha', SERVER_TOKEN));

    expect((await h.copyClientConfig({ name: 'beta' })).ok).toBe(true);
    const call2 = copyText.mock.calls[2]?.[0] ?? '';
    expect(JSON.parse(call2)).toEqual(expectedClient('beta', GATEWAY_TOKEN));
    expect(call2).not.toContain('X-Upstream-Secret');

    state.snapshot = {
      ...state.snapshot,
      configError: { code: 'InvalidConfig', message: 'broken', occurrenceId: 'issue-1' },
    };
    expect((await h.copyClientConfig({ name: 'alpha' })).ok).toBe(false);
    state.snapshot = { ...state.snapshot, configError: null };
    state.activeConfig = undefined;
    expect((await h.copyClientConfig({ name: 'alpha' })).ok).toBe(false);

    const dir = await makeTempDir();
    const configPath = join(dir, 'mcp.json');
    const linkFile = join(dir, 'link.json');
    state.snapshot = { ...state.snapshot, configPath };

    for (const target of ['docs', 'github', 'x'] as const) {
      expect((await h.openSocialLink({ target })).ok).toBe(true);
    }
    expect(desktop.openExternal.mock.calls.map((c) => c[0])).toEqual([
      'https://github.com/zaherg/mcp-gateway/blob/main/docs/README.md',
      'https://github.com/zaherg/mcp-gateway',
      'https://x.com/zaherg',
    ]);
    desktop.openExternal.mockReturnValueOnce(false);
    expect((await h.openSocialLink({ target: 'github' })).ok).toBe(false);

    expect((await h.revealConfig()).ok).toBe(true);
    expect(desktop.openPath.mock.calls).toEqual([[dirname(configPath)]]);
    expect(desktop.showItemInFolder).not.toHaveBeenCalled();

    desktop.openPath.mockReturnValueOnce(false);
    expect((await h.revealConfig()).ok).toBe(false);

    await writeFile(configPath, '{}', 'utf8');
    await symlink(configPath, linkFile);
    expect((await h.revealConfig()).ok).toBe(true);
    expect(desktop.showItemInFolder.mock.calls).toEqual([[configPath]]);

    desktop.openPath.mockClear();
    expect((await h.openConfigInEditor()).ok).toBe(true);
    expect(desktop.openPath.mock.calls).toEqual([[configPath]]);

    desktop.openPath.mockReturnValueOnce(false);
    expect((await h.openConfigInEditor()).ok).toBe(false);

    state.snapshot = { ...state.snapshot, configPath: linkFile };
    const symlinkRes = await h.openConfigInEditor();
    expect(!symlinkRes.ok && symlinkRes.error).toMatchObject({
      code: 'UnsafeFile',
      message: 'Symlinked configuration files are refused.',
    });

    state.snapshot = { ...state.snapshot, configPath: dir };
    const dirRes = await h.openConfigInEditor();
    expect(!dirRes.ok && dirRes.error.code).toBe('UnsafeFile');
  });
});

describe('AppService — importExternalServers security filtering & deduplication', () => {
  const setupFakeHome = async () => {
    const fakeHome = await makeTempDir('mcp-gateway-fake-home-');
    trackSpy(spyOn(os, 'homedir').mockReturnValue(fakeHome));
    const claudePath = join(
      fakeHome,
      'Library/Application Support/Claude/claude_desktop_config.json',
    );
    const cursorPath = join(fakeHome, '.cursor/mcp.json');
    await mkdir(dirname(claudePath), { recursive: true });
    await mkdir(dirname(cursorPath), { recursive: true });
    return { fakeHome, claudePath, cursorPath };
  };
  const writeServers = (path: string, mcpServers: Record<string, unknown>) =>
    writeFile(path, JSON.stringify({ mcpServers }), 'utf8');

  test('imports valid Claude Desktop and Cursor servers while filtering unsafe entries and duplicates', async () => {
    const { claudePath, cursorPath } = await setupFakeHome();
    const stdio = (extra: Record<string, unknown> = {}) => ({ command: '/usr/bin/env', ...extra });
    const http = (url: string, headers?: Record<string, string>) =>
      headers ? { url, headers } : { url };
    const goodStdio = {
      command: '/usr/local/bin/mcp-server',
      args: ['--port', '9000'],
      env: { SAFE_FLAG: '1' },
      cwd: '/tmp',
      disabled: false,
    };
    const goodHttp = {
      url: 'https://api.example.com/mcp',
      headers: { 'X-Custom': 'ok' },
      disabled: true,
    };

    await writeServers(claudePath, {
      good_stdio: goodStdio,
      alpha: { command: '/usr/bin/should-be-skipped' },
      shared_name: { command: '/usr/bin/from-claude' },
      bad_dyld: stdio({ env: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' } }),
      bad_ld: stdio({ env: { LD_PRELOAD: '/tmp/evil.so' } }),
      bad_node_opts: stdio({ env: { NODE_OPTIONS: '--require /tmp/e.js' } }),
      bad_bun_opts: stdio({ env: { BUN_OPTIONS: '--preload /tmp/e.js' } }),
      bad_cwd: stdio({ cwd: 'relative/path' }),
      ambiguous: stdio({ url: 'https://example.com/mcp' }),
      '../escape': stdio(),
    });

    await writeServers(cursorPath, {
      good_http: goodHttp,
      shared_name: { command: '/usr/bin/from-cursor' },
      self_loopback: http('http://127.0.0.1:3333/mcp/alpha'),
      self_localhost: http('http://localhost:3333/mcp/other'),
      link_local_v4: http('http://169.254.169.254/latest/meta-data'),
      link_local_v6: http('http://[fe80::1]/mcp'),
      unspecified_v4: http('http://0.0.0.0:8080/mcp'),
      with_userinfo: http('https://user:pass@example.com/mcp'),
      with_hash: http('https://example.com/mcp#frag'),
      file_scheme: http('file:///etc/passwd'),
      bad_host_header: http('https://api.example.com/mcp', { Host: 'spoof.com' }),
      bad_proxy_header: http('https://api.example.com/mcp', { 'Proxy-Authorization': 'Basic abc' }),
      bad_session_header: http('https://api.example.com/mcp', { 'Mcp-Session-Id': 'fixed' }),
    });

    const { service, controller } = createServiceHarness();
    const res = await service.handlers.importExternalServers({ expectedRevision: VALID_REVISION });
    expect(res.ok && res.value.importedCount).toBe(3);
    expect(controller.saveConfig).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(controller.saveConfig.mock.calls[0]?.[0] ?? '{}') as GatewayConfig;
    const expectedKeys = ['alpha', 'beta', 'good_http', 'good_stdio', 'shared_name'];
    expect(Object.keys(saved.mcpServers).sort()).toEqual(expectedKeys);
    expect(saved.mcpServers.good_stdio).toEqual(goodStdio);
    expect(saved.mcpServers.good_http).toEqual(goodHttp);
    expect(saved.mcpServers.shared_name).toEqual({ command: '/usr/bin/from-claude' });
  });

  test('skips symlinked/oversized/non-UTF-8/malformed files, enforces 64-server cap, skips empty saves, and filters port-80 self-proxy loops', async () => {
    const { fakeHome, claudePath, cursorPath } = await setupFakeHome();
    const realTarget = join(fakeHome, 'real-claude.json');
    await writeServers(realTarget, { from_symlink: { command: '/usr/bin/true' } });
    await symlink(realTarget, claudePath);

    const noImport = createServiceHarness();
    const noImportRes = await noImport.service.handlers.importExternalServers({
      expectedRevision: VALID_REVISION,
    });
    expect(noImportRes.ok && noImportRes.value.importedCount).toBe(0);
    expect(noImport.controller.saveConfig).not.toHaveBeenCalled();

    const manyServers = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`srv_${i}`, { command: '/usr/bin/true' }]),
    );
    await writeServers(cursorPath, manyServers);

    const cap = createServiceHarness();
    const capRes = await cap.service.handlers.importExternalServers({
      expectedRevision: VALID_REVISION,
    });
    expect(capRes.ok && capRes.value.importedCount).toBe(62);
    const saved = JSON.parse(cap.controller.saveConfig.mock.calls[0]?.[0] ?? '{}') as GatewayConfig;
    expect(Object.keys(saved.mcpServers)).toHaveLength(64);
    expect(saved.mcpServers.from_symlink).toBeUndefined();

    const staleRes = await cap.service.handlers.importExternalServers({
      expectedRevision: OTHER_REVISION,
    });
    expect(!staleRes.ok && staleRes.error.code).toBe('StaleRevision');

    const { claudePath: claude2, cursorPath: cursor2 } = await setupFakeHome();
    await writeServers(cursor2, {
      valid_cursor: { command: '/usr/bin/true' },
      self_port80: { url: 'http://127.0.0.1/mcp/alpha' },
    });
    const port80Config = {
      ...BASE_CONFIG,
      gateway: { ...BASE_CONFIG.gateway, port: 80 },
    };

    for (const brokenPayload of [
      Buffer.alloc(MAX_CONFIG_BYTES + 1, 0x20),
      Buffer.from([0x7b, 0xff, 0x7d]),
      Buffer.from('{', 'utf8'),
    ]) {
      await writeFile(claude2, brokenPayload);
      const { service, controller } = createServiceHarness({
        activeConfig: port80Config,
        configText: makeConfigText(port80Config),
      });
      const res = await service.handlers.importExternalServers({
        expectedRevision: VALID_REVISION,
      });
      expect(res.ok && res.value.importedCount).toBe(1);
      const s = JSON.parse(controller.saveConfig.mock.calls[0]?.[0] ?? '{}') as GatewayConfig;
      expect(s.mcpServers.valid_cursor).toEqual({ command: '/usr/bin/true' });
      expect(s.mcpServers.self_port80).toBeUndefined();
    }
  });
});

describe('app-updater — support resolution & verification helpers', () => {
  test('resolveUpdateSupport, verifyStagedAppBundleSignature, and verifyDownloadedUpdate enforce channel, signature, integrity manifest, and symlink/corruption guards', async () => {
    expect(await resolveUpdateSupport()).toEqual({ supported: true, installedVersion: '0.9.0' });
    sdkState.localInfo = { ...sdkState.localInfo, channel: 'dev' };
    expect(await resolveUpdateSupport()).toEqual({ supported: false, installedVersion: '0.9.0' });
    sdkState.localInfo = { ...sdkState.localInfo, channel: 'stable', version: '0.9.0-rc.1' };
    expect(await resolveUpdateSupport()).toEqual({ supported: false, installedVersion: null });
    sdkState.localInfo = { ...sdkState.localInfo, version: '0.9.0', baseUrl: '' };
    expect(await resolveUpdateSupport()).toEqual({ supported: false, installedVersion: '0.9.0' });
    sdkState.localInfo = { ...sdkState.localInfo, baseUrl: 'https://updates.example.com' };

    const dir = await makeTempDir('mcp-gateway-codesign-');
    const stagedApp = join(dir, 'Staged.app');
    const installedApp = join(dir, 'Installed.app');
    await mkdir(stagedApp);
    await mkdir(installedApp);

    const runSpy = trackSpy(spyOn(processModule, 'runCommand'));
    runSpy.mockImplementation(async (_cmd, args) => ({
      stdout: '',
      stderr: args.includes('--verify') ? 'valid on disk' : 'TeamIdentifier=TEAM123456\n',
      exitCode: 0,
    }));
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).resolves.toBeUndefined();
    expect(runSpy).toHaveBeenCalledTimes(3);

    runSpy.mockImplementation(async (_cmd, args) => ({
      stdout: '',
      stderr: args.includes('--verify')
        ? ''
        : args.includes(stagedApp)
          ? 'TeamIdentifier=OTHER99999\n'
          : 'TeamIdentifier=TEAM123456\n',
      exitCode: 0,
    }));
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).rejects.toThrow(
      'Staged update signing TeamIdentifier does not match the installed app.',
    );

    runSpy.mockResolvedValue({ stdout: '', stderr: 'invalid signature', exitCode: 1 });
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).rejects.toThrow(
      'Staged update failed codesign integrity verification.',
    );

    runSpy.mockImplementation(async (_cmd, args) => ({
      stdout: '',
      stderr: args.includes('--verify') ? '' : 'cannot read',
      exitCode: args.includes('--verify') ? 0 : 1,
    }));
    await expect(verifyStagedAppBundleSignature(stagedApp, installedApp)).rejects.toThrow(
      'Could not inspect staged update signing identity.',
    );

    const selfExtraction = join(dir, 'self-extraction');
    await mkdir(selfExtraction, { recursive: true });
    const preparedPath = join(selfExtraction, '.electrobun-prepared-update.json');
    await writeFile(preparedPath, JSON.stringify({ staging_path: stagedApp }), 'utf8');
    sdkState.appDataFolder = dir;

    const validManifest = {
      schemaVersion: 1,
      identifier: 'com.zaherg.mcp-gateway',
      channel: 'stable',
      version: '0.10.0',
      hash: 'def5678',
      artifact: { tarSha256: VALID_SHA256, tarSize: 1024 },
    };

    const fetchSpy = mockFetchWith(async () => new Response(JSON.stringify(validManifest)));
    runSpy.mockResolvedValue({ stdout: '', stderr: 'TeamIdentifier=not set\n', exitCode: 0 });
    runSpy.mockClear();

    const expectedUpdate = { version: '0.10.0', hash: 'def5678' };
    await expect(verifyDownloadedUpdate(expectedUpdate)).resolves.toBeUndefined();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://updates.example.com/stable-macos-arm64-update-v2.json',
    );
    expect(runSpy).toHaveBeenCalled();

    runSpy.mockClear();
    const symlinkStagedApp = join(dir, 'SymlinkStaged.app');
    await symlink(stagedApp, symlinkStagedApp);
    await writeFile(preparedPath, JSON.stringify({ staging_path: symlinkStagedApp }), 'utf8');
    await expect(verifyDownloadedUpdate(expectedUpdate)).resolves.toBeUndefined();
    expect(runSpy).not.toHaveBeenCalled();

    await writeFile(preparedPath, '{corrupted-json', 'utf8');
    await expect(verifyDownloadedUpdate(expectedUpdate)).rejects.toThrow();

    const realPrepared = join(dir, 'real-prepared.json');
    await writeFile(realPrepared, '{corrupted-json', 'utf8');
    const symlinkDir = await makeTempDir('mcp-gateway-updater-symlink-');
    await mkdir(join(symlinkDir, 'self-extraction'), { recursive: true });
    await symlink(
      realPrepared,
      join(symlinkDir, 'self-extraction', '.electrobun-prepared-update.json'),
    );
    sdkState.appDataFolder = symlinkDir;
    await expect(verifyDownloadedUpdate(expectedUpdate)).resolves.toBeUndefined();

    sdkState.appDataFolder = '';
    for (const [body, status, msg] of [
      ['fail', 503, 'Update integrity manifest check failed (HTTP 503).'],
      ['{bad json', 200, 'Update integrity manifest contains invalid JSON.'],
      ['[]', 200, 'Update integrity manifest must be an object.'],
    ] as const) {
      fetchSpy.mockResolvedValueOnce(new Response(body, { status }));
      await expect(verifyDownloadedUpdate(expectedUpdate)).rejects.toThrow(msg);
    }

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
      await expect(verifyDownloadedUpdate(expectedUpdate)).rejects.toThrow(
        'Downloaded update failed integrity manifest verification.',
      );
    }

    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(verifyDownloadedUpdate(expectedUpdate)).resolves.toBeUndefined();
  });
});

describe('AppUpdater', () => {
  const createTestUpdater = async (
    opts: Partial<{
      dir: string;
      supported: boolean;
      installedVersion: string | null;
      preferenceRaw: string;
      automaticUpdates: boolean;
      cleanup: () => Promise<void>;
      quit: QuitCoordinator;
    }> = {},
  ) => {
    const dir = opts.dir ?? (await makeTempDir('mcp-gateway-updater-'));
    const prefPath = join(dir, 'updates.json');
    const raw =
      opts.preferenceRaw ??
      (opts.automaticUpdates !== undefined
        ? JSON.stringify({ schema_version: 1, automaticUpdates: opts.automaticUpdates })
        : undefined);
    if (raw !== undefined) {
      await writeFile(prefPath, raw, { mode: 0o600 });
      await chmod(prefPath, 0o600);
    }
    const { coordinator, failures } = makeQuitCoordinator(opts.cleanup);
    const quit = opts.quit ?? coordinator;
    const installedVersion = opts.installedVersion !== undefined ? opts.installedVersion : '0.9.0';
    const cfg = { dataDirectory: dir, supported: opts.supported ?? true, installedVersion, quit };
    return {
      dir,
      prefPath,
      updater: trackUpdater(new AppUpdater(cfg)),
      coordinator: quit,
      failures,
    };
  };

  test('manages updates.json preferences, unsupported builds, and stop() shutdown lifecycle', async () => {
    const { dir, updater: first } = await createTestUpdater();
    expect(await first.start()).toMatchObject({ automaticUpdates: true, phase: 'idle' });
    first.stop();

    const { updater: second } = await createTestUpdater({ dir, automaticUpdates: false });
    expect(await second.start()).toMatchObject({ automaticUpdates: false, phase: 'idle' });
    second.stop();

    const setTimeoutSpy = trackSpy(spyOn(globalThis, 'setTimeout'));
    const badRaw = JSON.stringify({ schema_version: 1, automaticUpdates: true, extra: true });
    const bad = await createTestUpdater({ preferenceRaw: badRaw });
    expect(await bad.updater.start()).toMatchObject({
      automaticUpdates: false,
      phase: 'error',
      error: PREFERENCE_ERROR,
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    expect(await bad.updater.setAutomatic(true)).toMatchObject({
      automaticUpdates: true,
      phase: 'idle',
      error: null,
    });
    expect((await stat(bad.prefPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(bad.prefPath, 'utf8'))).toEqual({
      schema_version: 1,
      automaticUpdates: true,
    });

    const clearTimeoutSpy = trackSpy(spyOn(globalThis, 'clearTimeout'));
    await chmod(bad.dir, 0o500);
    await expect(bad.updater.setAutomatic(false)).rejects.toThrow();
    expect(bad.updater.status().automaticUpdates).toBe(true);
    expect(clearTimeoutSpy).not.toHaveBeenCalled();

    await chmod(bad.dir, 0o700);
    expect((await bad.updater.setAutomatic(false)).automaticUpdates).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect((await stat(bad.prefPath)).mode & 0o777).toBe(0o600);
    bad.updater.stop();

    const fetchSpy = mockFetchWith(async () => {
      throw new Error('network should not be called');
    });
    const { updater: unsup } = await createTestUpdater({
      supported: false,
      installedVersion: null,
    });
    expect(await unsup.start()).toMatchObject({
      supported: false,
      automaticUpdates: false,
      phase: 'idle',
    });
    expect(sdkState.onStatusChangeCalls.at(-1)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    for (const action of [
      () => unsup.check(),
      () => unsup.download(),
      () => unsup.installUpdate(),
      () => unsup.setAutomatic(true),
      () => unsup.restart(),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(RequestError);
      await expect(action()).rejects.toThrow('Updates are unavailable in this build.');
    }

    const { updater } = await createTestUpdater();
    const seen: UpdateStatus[] = [];
    updater.subscribe((status) => seen.push(status));
    await updater.start();
    expect(seen.length).toBeGreaterThan(0);

    updater.stop();
    expect(sdkState.onStatusChangeCalls.at(-1)).toBeNull();
    const shutdownMsg = 'Update work is unavailable after shutdown has started.';
    await expect(updater.check()).rejects.toThrow(shutdownMsg);
    await expect(updater.setAutomatic(false)).rejects.toThrow(shutdownMsg);
  });

  test('check() and handleSdkStatus transition phases, enforce eligibility, sanitize secret URLs, and auto-download when automaticUpdates is true', async () => {
    const { updater } = await createTestUpdater({ automaticUpdates: false });
    await updater.start();

    const phases: string[] = [];
    updater.subscribe((s) => phases.push(s.phase));

    sdkState.checkForUpdateImpl = async () => makeUpdateInfo({ version: '0.9.0', hash: 'abc1234' });
    const upToDate = await updater.check();
    expect(upToDate).toMatchObject({ phase: 'idle', availableVersion: null });
    expect(upToDate.checkedAt).not.toBeNull();
    expect(phases).toEqual(['checking', 'idle']);

    const ineligibleError = {
      phase: 'error',
      availableVersion: null,
      error: 'The offered update version is not eligible.',
    };
    sdkState.checkForUpdateImpl = async () => availInfo('0.8.9', 'old1234');
    expect(await updater.check()).toMatchObject(ineligibleError);

    phases.length = 0;
    sdkState.checkForUpdateImpl = async () => availInfo('0.10.0');
    expect(await updater.check()).toMatchObject({ phase: 'available', availableVersion: '0.10.0' });
    expect(phases).toEqual(['checking', 'available']);

    sdkState.checkForUpdateImpl = async () => {
      throw new Error(
        'Failed https://admin:topsecret@updates.example.com/feed?token=leak123 Authorization: Bearer tok_secret',
      );
    };
    const errored = await updater.check();
    expect(errored.phase).toBe('error');
    for (const secret of ['topsecret', 'leak123', 'tok_secret']) {
      expect(errored.error).not.toContain(secret);
    }
    for (const marker of ['://[REDACTED]@', 'token=[REDACTED]', 'Bearer [REDACTED]']) {
      expect(errored.error).toContain(marker);
    }

    sdkState.updateInfo = availInfo('0.9.1');
    emitSdkStatus('update-available');
    expect(updater.status()).toMatchObject({ phase: 'available', availableVersion: '0.9.1' });

    for (const badVersion of ['0.9.0-beta.1', '0.8.9']) {
      sdkState.updateInfo = { ...sdkState.updateInfo, version: badVersion };
      emitSdkStatus('update-available');
      expect(updater.status()).toMatchObject(ineligibleError);
    }

    emitSdkStatus('no-update');
    expect(updater.status()).toMatchObject({ phase: 'idle', availableVersion: null, error: null });

    emitSdkStatus('error', {
      message: 'Failed https://user:secret123@updates.example.com/feed?token=abc999',
    });
    expect(updater.status().phase).toBe('error');
    expect(updater.status().error).not.toContain('secret123');
    expect(updater.status().error).not.toContain('abc999');
    expect(updater.status().error).toContain('://[REDACTED]@');
    updater.stop();

    mockFetchWith(async () => new Response('not found', { status: 404 }));
    let downloadCalls = 0;
    sdkState.checkForUpdateImpl = async () => availInfo('0.9.1');
    sdkState.downloadUpdateImpl = async () => {
      downloadCalls++;
      sdkState.updateInfo = readyInfo('0.9.1');
    };
    const { updater: autoUpdater } = await createTestUpdater({ automaticUpdates: true });
    await autoUpdater.start();
    await autoUpdater.check();
    await flushMicrotasks();
    expect(downloadCalls).toBe(1);
    expect(autoUpdater.status()).toMatchObject({ phase: 'ready', availableVersion: '0.9.1' });
  });

  test('download(), restart(), installUpdate(), and seedFromSdk() track progress, verify updates, and coordinate quit lifecycle', async () => {
    mockFetchWith(async () => new Response('not found', { status: 404 }));
    const { updater } = await createTestUpdater({ automaticUpdates: false });
    await updater.start();
    await expect(updater.download()).rejects.toThrow(
      'No eligible update is available to download.',
    );

    sdkState.checkForUpdateImpl = async () => availInfo('0.10.0');
    await updater.check();

    const gate = deferred();
    const snapshots: UpdateStatus[] = [];
    updater.subscribe((s) => snapshots.push(s));

    sdkState.downloadUpdateImpl = async () => {
      emitSdkStatus('download-progress', { details: { bytesDownloaded: 500, totalBytes: 1000 } });
      await gate.promise;
      sdkState.updateInfo = readyInfo('0.10.0');
    };

    expect((await updater.download()).phase).toBe('downloading');
    expect(updater.status()).toMatchObject({ progressPercent: 50, downloadedBytes: 500 });
    expect((await updater.download()).phase).toBe('downloading');

    gate.resolve();
    await flushMicrotasks();

    const ready010 = { phase: 'ready', availableVersion: '0.10.0', progressPercent: 100 };
    expect(updater.status()).toMatchObject(ready010);
    expect(snapshots.some((s) => s.phase === 'downloading' && s.progressPercent === 50)).toBe(true);
    expect(snapshots.some((s) => s.phase === 'ready' && s.progressPercent === 100)).toBe(true);
    updater.stop();

    sdkState.updateInfo = makeUpdateInfo();
    let cleanupCount = 0;
    const cleanup = async () => {
      cleanupCount++;
    };
    const ok = await createTestUpdater({ automaticUpdates: false, cleanup });
    await ok.updater.start();
    await expect(ok.updater.restart()).rejects.toThrow('No verified update is ready to install.');

    const launchEntry = { status: 'launching-new-version' as const, message: 'ok', timestamp: 0 };
    sdkState.updateInfo = readyInfo('0.10.0');
    sdkState.applyUpdateImpl = async () => {
      expect(ok.coordinator.updateRestartActive()).toBe(true);
      sdkState.statusHistory.push(launchEntry);
    };

    const restartStatus = await ok.updater.restart();
    expect(cleanupCount).toBe(1);
    expect(restartStatus.phase).toBe('pending');
    expect(ok.coordinator.updateRestartActive()).toBe(false);
    expect(ok.failures).toEqual([]);
    expect(ok.updater.status().phase).toBe('restarting');
    ok.updater.stop();

    const fail = await createTestUpdater({ dir: ok.dir });
    await fail.updater.start();
    sdkState.statusHistory = [];
    sdkState.applyUpdateImpl = async () => {
      throw new Error('helper binary missing');
    };

    const failedQuitStatus = await fail.updater.restart();
    expect(failedQuitStatus.phase).toBe('failed');
    expect(failedQuitStatus.error).toContain('Update handoff failed.');
    expect(fail.updater.status()).toMatchObject({ phase: 'error', error: 'helper binary missing' });
    expect(fail.failures[0]?.kind).toBe('update');
    fail.updater.stop();

    const { coordinator: quitCoordinator } = makeQuitCoordinator();
    quitCoordinator.armQuit();
    const { updater: blocked } = await createTestUpdater({ dir: ok.dir, quit: quitCoordinator });
    await blocked.start();
    await expect(blocked.restart()).rejects.toThrow(
      'Quit cleanup has started. Retry Quit to close the app.',
    );
    blocked.stop();

    sdkState.updateInfo = readyInfo('0.10.0');
    let applyCalls = 0;
    sdkState.applyUpdateImpl = async () => {
      applyCalls++;
      sdkState.statusHistory.push(launchEntry);
    };
    const { updater: seededUpdater } = await createTestUpdater({ automaticUpdates: false });
    expect(await seededUpdater.start()).toMatchObject(ready010);
    expect((await seededUpdater.installUpdate()).phase).toBe('restarting');
    expect(applyCalls).toBe(1);
  });
});
