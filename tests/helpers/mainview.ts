import type { Locale } from '@mcp-gateway/shared/i18n';
import type {
  AppClient,
  AppearancePreference,
  AppResult,
  AppSnapshot,
  MenuCommand,
  UpdateStatus,
} from '@mcp-gateway/shared/rpc';
import type { GatewaySnapshot } from '@mcp-gateway/shared/types';
import { fireEvent } from './dom';

export const DEFAULT_REVISION = 'rev-1';
export const SECOND_REVISION = 'rev-2';
export const THIRD_REVISION = 'rev-3';

export const setNavigatorLanguages = (languages: readonly string[]) => {
  Object.defineProperty(navigator, 'languages', {
    configurable: true,
    value: languages,
  });
};

export const setInputValue = (element: HTMLElement, value: string) => {
  fireEvent.focus(element);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
};

export const makeUpdateStatus = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  supported: true,
  automaticUpdates: true,
  installedVersion: '0.9.0',
  availableVersion: null,
  phase: 'idle',
  error: null,
  checkedAt: null,
  ...overrides,
});

export const makeConfigText = (
  servers: Record<string, unknown> = {},
  gatewayOverrides: Record<string, unknown> = {},
) =>
  JSON.stringify(
    {
      gateway: {
        host: '127.0.0.1',
        port: 8787,
        token: 'a'.repeat(64),
        ...gatewayOverrides,
      },
      mcpServers: servers,
    },
    null,
    2,
  );

export const makeGatewaySnapshot = (overrides: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({
  configPath: '/tmp/mcp.json',
  configFormat: 'json',
  configText: makeConfigText(),
  revision: DEFAULT_REVISION,
  running: false,
  interfaces: [
    { name: 'lo0', address: '127.0.0.1', netmask: '255.0.0.0', kind: 'loopback' },
    { name: 'en0', address: '192.168.1.25', netmask: '255.255.255.0', kind: 'lan' },
  ],
  network: 'loopback',
  keyMigration: { gateway: false, servers: [] },
  servers: [],
  configError: null,
  operationalError: null,
  ...overrides,
});

export type SnapshotOverrides = {
  gateway?: Partial<GatewaySnapshot>;
  gatewayOverrides?: Partial<GatewaySnapshot>;
  login?: Partial<AppSnapshot['login']>;
  update?: Partial<UpdateStatus>;
  whatsNew?: string | null;
  keyReminder?: boolean;
  language?: Partial<AppSnapshot['language']>;
  appearance?: AppearancePreference;
  locale?: Locale;
  configPath?: string;
  configFormat?: 'json' | 'jsonc';
  configText?: string;
  revision?: string;
  running?: boolean;
};

export const makeSnapshot = (overrides: SnapshotOverrides = {}): AppSnapshot => {
  const locale = overrides.locale ?? overrides.language?.locale ?? 'en_US';
  const gatewayPatch: Partial<GatewaySnapshot> = {
    ...(overrides.configPath !== undefined ? { configPath: overrides.configPath } : {}),
    ...(overrides.configFormat !== undefined ? { configFormat: overrides.configFormat } : {}),
    ...(overrides.configText !== undefined ? { configText: overrides.configText } : {}),
    ...(overrides.revision !== undefined ? { revision: overrides.revision } : {}),
    ...(overrides.running !== undefined ? { running: overrides.running } : {}),
    ...overrides.gateway,
    ...overrides.gatewayOverrides,
  };
  return {
    gateway: makeGatewaySnapshot(gatewayPatch),
    login: { enabled: false, supported: true, error: null, ...overrides.login },
    update: makeUpdateStatus(overrides.update),
    whatsNew: overrides.whatsNew ?? null,
    keyReminder: overrides.keyReminder ?? false,
    language: {
      preference: locale,
      locale,
      system: 'en_US',
      available: ['en_US', 'fr_FR', 'de_DE', 'tr_TR'],
      ...overrides.language,
    },
    appearance: overrides.appearance ?? 'system',
  };
};

export interface MockClientBundle {
  client: AppClient;
  emitSnapshot: (snapshot: AppSnapshot) => void;
  emitMenuCommand: (command: MenuCommand) => void;
  snapshotListenerCount: () => number;
  menuListenerCount: () => number;
  calls: {
    snapshot: number;
    saveConfig: Array<{ text: string; expectedRevision: string }>;
    confirmDeleteServer: Array<{ name: string }>;
    confirmDiscard: number;
    testServer: Array<{ name: string; expectedRevision: string }>;
    migrateKeys: Array<{ gateway: boolean; servers: string[]; expectedRevision: string }>;
    validateConfig: Array<{ text: string }>;
    revealConfig: number;
    openConfigInEditor: number;
    importExternalServers: Array<{ expectedRevision: string }>;
    dismissKeyReminder: number;
    dismissWhatsNew: number;
    setLanguage: Array<{ preference: string }>;
    setAppearance: Array<{ preference: AppearancePreference }>;
    updatesCheck: number;
    updatesDownload: number;
    updatesInstall: number;
    updatesRestart: number;
    updatesSetAutomatic: Array<{ automatic: boolean }>;
  };
}

export const createMockAppClient = (
  initialSnapshot: AppSnapshot = makeSnapshot(),
  overrides: Partial<AppClient> = {},
): MockClientBundle => {
  const snapshotListeners = new Set<(snapshot: AppSnapshot) => void>();
  const menuListeners = new Set<(command: MenuCommand) => void>();
  let revisionCounter = 1;
  let currentSnapshot = initialSnapshot;

  const calls: MockClientBundle['calls'] = {
    snapshot: 0,
    saveConfig: [],
    confirmDeleteServer: [],
    confirmDiscard: 0,
    testServer: [],
    migrateKeys: [],
    validateConfig: [],
    revealConfig: 0,
    openConfigInEditor: 0,
    importExternalServers: [],
    dismissKeyReminder: 0,
    dismissWhatsNew: 0,
    setLanguage: [],
    setAppearance: [],
    updatesCheck: 0,
    updatesDownload: 0,
    updatesInstall: 0,
    updatesRestart: 0,
    updatesSetAutomatic: [],
  };

  const emitSnapshot = (next: AppSnapshot) => {
    currentSnapshot = next;
    for (const listener of snapshotListeners) listener(next);
  };

  const unusedError = async <T>(method: string): Promise<AppResult<T>> => ({
    ok: false,
    error: { code: 'Unimplemented', message: `Unexpected call to ${method}` },
  });

  const baseClient: AppClient = {
    snapshot: async () => {
      calls.snapshot += 1;
      return { ok: true, value: currentSnapshot };
    },
    saveConfig: async (params) => {
      calls.saveConfig.push(params);
      revisionCounter += 1;
      const updated = {
        ...currentSnapshot,
        gateway: {
          ...currentSnapshot.gateway,
          configText: params.text,
          revision: `rev-${revisionCounter}`,
        },
      };
      // Mirrors `wrapHandler` in `src/main/index.ts`, which pushes `snapshotChanged` before resolving.
      emitSnapshot(updated);
      return { ok: true, value: updated };
    },
    confirmDeleteServer: async (params) => {
      calls.confirmDeleteServer.push(params);
      return { ok: true, value: true };
    },
    confirmDiscard: async () => {
      calls.confirmDiscard += 1;
      return { ok: true, value: true };
    },
    readLogs: async () => ({
      ok: true,
      value: { entries: [], cursor: 0, generation: 1, gap: false, hasMore: false },
    }),
    clearLogs: async () => ({
      ok: true,
      value: { entries: [], cursor: 0, generation: 2, gap: false, hasMore: false },
    }),
    quit: () => unusedError('quit'),
    quitStatus: () => unusedError('quitStatus'),
    start: async () => {
      const next = {
        ...currentSnapshot,
        gateway: { ...currentSnapshot.gateway, running: true },
      };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    stop: async () => {
      const next = {
        ...currentSnapshot,
        gateway: { ...currentSnapshot.gateway, running: false },
      };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    testServer: async (params) => {
      calls.testServer.push(params);
      return { ok: true, value: { protocolVersion: '2025-11-25' } };
    },
    migrateKeys: async (params) => {
      calls.migrateKeys.push(params);
      revisionCounter += 1;
      const next = {
        ...currentSnapshot,
        gateway: {
          ...currentSnapshot.gateway,
          revision: `rev-${revisionCounter}`,
          keyMigration: { gateway: false, servers: [] },
        },
      };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    dismissKeyReminder: async () => {
      calls.dismissKeyReminder += 1;
      const next = { ...currentSnapshot, keyReminder: false };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    validateConfig: async (params) => {
      calls.validateConfig.push(params);
      return { ok: true, value: { issue: null } };
    },
    copyEndpoint: async () => ({ ok: true, value: null }),
    copyClientConfig: async () => ({ ok: true, value: null }),
    openSocialLink: async () => ({ ok: true, value: null }),
    revealConfig: async () => {
      calls.revealConfig += 1;
      return { ok: true, value: null };
    },
    openConfigInEditor: async () => {
      calls.openConfigInEditor += 1;
      return { ok: true, value: null };
    },
    importExternalServers: async (params) => {
      calls.importExternalServers.push(params);
      return { ok: true, value: { snapshot: currentSnapshot, importedCount: 2 } };
    },
    dismissWhatsNew: async () => {
      calls.dismissWhatsNew += 1;
      return { ok: true, value: null };
    },
    updatesCheck: async () => {
      calls.updatesCheck += 1;
      return {
        ok: true,
        value: {
          ...currentSnapshot.update,
          checkedAt: '2026-11-27T08:00:00.000Z',
        },
      };
    },
    updatesDownload: async () => {
      calls.updatesDownload += 1;
      return { ok: true, value: currentSnapshot.update };
    },
    updatesInstall: async () => {
      calls.updatesInstall += 1;
      return {
        ok: true,
        value: {
          ...currentSnapshot.update,
          phase: 'downloading',
          progressPercent: 10,
        },
      };
    },
    updatesSetAutomatic: async (params) => {
      calls.updatesSetAutomatic.push(params);
      return {
        ok: true,
        value: {
          ...currentSnapshot.update,
          automaticUpdates: params.automatic,
        },
      };
    },
    setLanguage: async (params) => {
      calls.setLanguage.push(params);
      const nextLocale = params.preference === 'system' ? 'en_US' : params.preference;
      const next = {
        ...currentSnapshot,
        language: {
          ...currentSnapshot.language,
          preference: params.preference,
          locale: nextLocale,
        },
      };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    setAppearance: async (params) => {
      calls.setAppearance.push(params);
      const next = {
        ...currentSnapshot,
        appearance: params.preference,
      };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    updatesRestart: async () => {
      calls.updatesRestart += 1;
      return {
        ok: true,
        value: { requested: true, status: { attempt: 1, phase: 'pending', error: null } },
      };
    },
    onSnapshotChanged: (listener) => {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
    onMenuCommand: (listener) => {
      menuListeners.add(listener);
      return () => {
        menuListeners.delete(listener);
      };
    },
  };

  return {
    client: { ...baseClient, ...overrides },
    emitSnapshot,
    emitMenuCommand: (command) => {
      for (const listener of menuListeners) listener(command);
    },
    snapshotListenerCount: () => snapshotListeners.size,
    menuListenerCount: () => menuListeners.size,
    calls,
  };
};
