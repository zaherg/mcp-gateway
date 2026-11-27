import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { act, render, waitFor } from '@testing-library/react';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';

import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { createKeyValueRow } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useOperations } from '@mcp-gateway/mainview/hooks/useOperations';
import { I18nProvider, useI18n } from '@mcp-gateway/mainview/i18n';
import { type Locale, translator } from '@mcp-gateway/shared/i18n';
import type {
  AppClient,
  AppResult,
  AppSnapshot,
  MenuCommand,
  UpdateStatus,
} from '@mcp-gateway/shared/rpc';
import type { ConfigFile } from '@mcp-gateway/shared/types';
import { cleanupDom, installDomEnvironment } from '../helpers/dom';

installDomEnvironment();

let unsavedRawConfigChecker: () => boolean = () => false;
const fallbackSnapshotListeners = new Set<(snapshot: AppSnapshot) => void>();
const fallbackMenuListeners = new Set<(command: MenuCommand) => void>();

// Mock `@mcp-gateway/mainview/client` before importing `GatewayViewContext` so `rpc.ts`
// (`new Electroview({ rpc })`) is never evaluated outside a live Electrobun WebView.
mock.module('@mcp-gateway/mainview/client', () => ({
  client: {} as AppClient,
  setUnsavedRawConfigChecker: (checker: () => boolean) => {
    unsavedRawConfigChecker = checker;
  },
  onSnapshotChanged: (listener: (snapshot: AppSnapshot) => void) => {
    fallbackSnapshotListeners.add(listener);
    return () => {
      fallbackSnapshotListeners.delete(listener);
    };
  },
  onMenuCommand: (listener: (command: MenuCommand) => void) => {
    fallbackMenuListeners.add(listener);
    return () => {
      fallbackMenuListeners.delete(listener);
    };
  },
}));

const { GatewayViewProvider, useGatewayView } = await import(
  '@mcp-gateway/mainview/context/GatewayViewContext'
);

type GatewayViewValue = ReturnType<typeof useGatewayView>;

const defaultLanguages = navigator.languages;

const setNavigatorLanguages = (languages: readonly string[]): void => {
  Object.defineProperty(navigator, 'languages', {
    configurable: true,
    value: languages,
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeFormEvent = (): FormEvent =>
  ({
    preventDefault: () => {},
  }) as FormEvent;

const makeUpdateStatus = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  supported: true,
  automaticUpdates: true,
  installedVersion: '0.9.0',
  availableVersion: null,
  phase: 'idle',
  error: null,
  checkedAt: null,
  ...overrides,
});

const makeConfigText = (servers: Record<string, unknown> = {}): string =>
  JSON.stringify(
    {
      gateway: {
        host: '127.0.0.1',
        port: 8787,
        token: 'a'.repeat(64),
      },
      mcpServers: servers,
    },
    null,
    2,
  );

const makeSnapshot = (
  overrides: {
    configPath?: string;
    configFormat?: 'json' | 'jsonc';
    configText?: string;
    revision?: string;
    running?: boolean;
    locale?: Locale;
    update?: Partial<UpdateStatus>;
  } = {},
): AppSnapshot => {
  const locale = overrides.locale ?? 'en_US';
  return {
    gateway: {
      configPath: overrides.configPath ?? '/tmp/mcp.json',
      configFormat: overrides.configFormat ?? 'json',
      configText: overrides.configText ?? makeConfigText(),
      revision: overrides.revision ?? 'rev-1',
      running: overrides.running ?? false,
      interfaces: [{ name: 'lo0', address: '127.0.0.1', netmask: '255.0.0.0', kind: 'loopback' }],
      network: 'loopback',
      keyMigration: { gateway: false, servers: [] },
      servers: [],
      configError: null,
      operationalError: null,
    },
    login: { enabled: false, supported: true, error: null },
    update: makeUpdateStatus(overrides.update),
    whatsNew: null,
    keyReminder: false,
    language: {
      preference: locale,
      locale,
      system: 'en_US',
      available: ['en_US', 'fr_FR', 'de_DE', 'tr_TR'],
    },
  };
};

interface MockClientBundle {
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
  };
}

const createMockAppClient = (
  initialSnapshot: AppSnapshot,
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
  };

  const emitSnapshot = (next: AppSnapshot): void => {
    currentSnapshot = next;
    for (const listener of snapshotListeners) listener(next);
  };

  const unusedError = async <T,>(method: string): Promise<AppResult<T>> => ({
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
      const updated: AppSnapshot = {
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
    readLogs: () => unusedError('readLogs'),
    clearLogs: () => unusedError('clearLogs'),
    quit: () => unusedError('quit'),
    quitStatus: () => unusedError('quitStatus'),
    start: () => unusedError('start'),
    stop: () => unusedError('stop'),
    restartServer: () => unusedError('restartServer'),
    testServer: () => unusedError('testServer'),
    migrateKeys: () => unusedError('migrateKeys'),
    dismissKeyReminder: () => unusedError('dismissKeyReminder'),
    validateConfig: () => unusedError('validateConfig'),
    copyEndpoint: () => unusedError('copyEndpoint'),
    copyClientConfig: () => unusedError('copyClientConfig'),
    openSocialLink: () => unusedError('openSocialLink'),
    revealConfig: () => unusedError('revealConfig'),
    openConfigInEditor: () => unusedError('openConfigInEditor'),
    importExternalServers: () => unusedError('importExternalServers'),
    dismissWhatsNew: async () => ({ ok: true, value: null }),
    updatesCheck: () => unusedError('updatesCheck'),
    updatesDownload: () => unusedError('updatesDownload'),
    updatesInstall: () => unusedError('updatesInstall'),
    updatesSetAutomatic: () => unusedError('updatesSetAutomatic'),
    setLanguage: () => unusedError('setLanguage'),
    updatesRestart: () => unusedError('updatesRestart'),
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

  const client: AppClient = { ...baseClient, ...overrides };

  return {
    client,
    emitSnapshot,
    emitMenuCommand: (command) => {
      for (const listener of menuListeners) listener(command);
    },
    snapshotListenerCount: () => snapshotListeners.size,
    menuListenerCount: () => menuListeners.size,
    calls,
  };
};

const BareI18nConsumer = () => {
  useI18n();
  return null;
};

const I18nBasicProbe = ({
  onLocaleSetter,
}: {
  onLocaleSetter?: (setter: (locale: Locale) => void) => void;
}) => {
  const i18n = useI18n();
  onLocaleSetter?.(i18n.setLocale);
  return (
    <div>
      <span data-testid="locale">{i18n.locale}</span>
      <span data-testid="cancel">{i18n.t('common.cancel')}</span>
      <span data-testid="quit">{i18n.t('common.quitApp', { app: 'MCP Gateway' })}</span>
      <span data-testid="lang-name">{i18n.t('language.name')}</span>
      <span data-testid="add">{i18n.t('overview.addServer')}</span>
    </div>
  );
};

const I18nRichProbe = () => {
  const { rich } = useI18n();
  return (
    <div>
      <p data-testid="single">
        {rich('editor.nameHelp', {
          path: <code data-testid="path-code">/mcp/bear</code>,
        })}
      </p>
      <p data-testid="multi">
        {rich('logs.limits', {
          entries: <strong data-testid="entries-strong">500</strong>,
          megabytes: <code data-testid="mb-code">4</code>,
        })}
      </p>
    </div>
  );
};

interface OperationsState {
  busy: boolean;
  updateBusy: boolean;
  error: string | null;
  snapshot: AppSnapshot | null;
  doc: Document | null;
  generation: number;
  quitGeneration: number;
  editSequence: number;
}

interface OperationsBridge {
  run: ReturnType<typeof useOperations>['run'];
  runUpdate: ReturnType<typeof useOperations>['runUpdate'];
  state: OperationsState;
  setDocLocal: (next: Document) => void;
  bumpEditSequence: () => void;
  bumpQuitGeneration: () => void;
  setUpdateBusyDirectly: (value: boolean) => void;
}

const OperationsHarnessComponent = ({
  initialSnapshot,
  initialDoc,
  initialUpdateBusy,
  onSync,
  children,
}: {
  initialSnapshot: AppSnapshot | null;
  initialDoc: Document | null;
  initialUpdateBusy: boolean;
  onSync: (bridge: OperationsBridge) => void;
  children?: ReactNode;
}) => {
  const quitGeneration = useRef(0);
  const generation = useRef(0);
  const editSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(initialUpdateBusy);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(initialSnapshot);
  const [doc, setDocState] = useState<Document | null>(initialDoc);
  const docRef = useRef<Document | null>(doc);
  docRef.current = doc;

  const ops = useOperations({
    quitGeneration,
    generation,
    editSequence,
    docRef,
    setBusy,
    updateBusy,
    setUpdateBusy,
    setError,
    setSnapshot,
    setDoc: (next) => {
      docRef.current = next;
      setDocState(next);
    },
  });

  onSync({
    run: ops.run,
    runUpdate: ops.runUpdate,
    state: {
      busy,
      updateBusy,
      error,
      snapshot,
      doc,
      generation: generation.current,
      quitGeneration: quitGeneration.current,
      editSequence: editSequence.current,
    },
    setDocLocal: (next) => {
      editSequence.current += 1;
      docRef.current = next;
      setDocState(next);
    },
    bumpEditSequence: () => {
      editSequence.current += 1;
    },
    bumpQuitGeneration: () => {
      quitGeneration.current += 1;
    },
    setUpdateBusyDirectly: setUpdateBusy,
  });

  return <>{children}</>;
};

const BareGatewayConsumer = () => {
  useGatewayView();
  return null;
};

const GatewayContextProbe = ({ onSync }: { onSync: (value: GatewayViewValue) => void }) => {
  const value = useGatewayView();
  onSync(value);
  return null;
};

beforeEach(() => {
  setNavigatorLanguages(['en-US']);
  unsavedRawConfigChecker = () => false;
});

afterEach(() => {
  cleanupDom();
  setNavigatorLanguages(defaultLanguages);
  document.documentElement.lang = '';
  fallbackSnapshotListeners.clear();
  fallbackMenuListeners.clear();
});

describe('I18nProvider and useI18n', () => {
  test('throws when useI18n is called outside I18nProvider', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(() => render(<BareI18nConsumer />)).toThrow(
        'useI18n must be used inside I18nProvider.',
      );
    } finally {
      console.error = originalError;
    }
  });

  test('renders children with en_US by default and syncs documentElement.lang', () => {
    const view = render(
      <I18nProvider>
        <I18nBasicProbe />
      </I18nProvider>,
    );

    expect(view.getByTestId('locale').textContent).toBe('en_US');
    expect(document.documentElement.lang).toBe('en-US');
    expect(view.getByTestId('cancel').textContent).toBe('Cancel');
    expect(view.getByTestId('quit').textContent).toBe('Quit MCP Gateway');
  });

  test('initializes locale from navigator.languages', () => {
    setNavigatorLanguages(['fr-CA', 'en-US']);
    const view = render(
      <I18nProvider>
        <I18nBasicProbe />
      </I18nProvider>,
    );

    expect(view.getByTestId('locale').textContent).toBe('fr_FR');
    expect(document.documentElement.lang).toBe('fr-FR');
    expect(view.getByTestId('cancel').textContent).toBe('Annuler');
  });

  test('switches between fr_FR, de_DE, tr_TR, and en_US updating lang and localized strings', () => {
    let setLocale!: (locale: Locale) => void;
    const view = render(
      <I18nProvider>
        <I18nBasicProbe
          onLocaleSetter={(setter) => {
            setLocale = setter;
          }}
        />
      </I18nProvider>,
    );

    const cases: Array<{ locale: Locale; tag: string; name: string; add: string }> = [
      {
        locale: 'fr_FR',
        tag: 'fr-FR',
        name: 'Français (France)',
        add: 'Ajouter un serveur',
      },
      {
        locale: 'de_DE',
        tag: 'de-DE',
        name: 'Deutsch (Deutschland)',
        add: 'Server hinzufügen',
      },
      {
        locale: 'tr_TR',
        tag: 'tr-TR',
        name: 'Türkçe (Türkiye)',
        add: 'Sunucu ekle',
      },
      {
        locale: 'en_US',
        tag: 'en-US',
        name: 'English (United States)',
        add: 'Add server',
      },
    ];

    for (const entry of cases) {
      act(() => {
        setLocale(entry.locale);
      });
      expect(view.getByTestId('locale').textContent).toBe(entry.locale);
      expect(document.documentElement.lang).toBe(entry.tag);
      expect(view.getByTestId('lang-name').textContent).toBe(entry.name);
      expect(view.getByTestId('add').textContent).toBe(entry.add);
    }
  });

  test('rich() substitutes React nodes while preserving surrounding text and unmatched placeholders', () => {
    const view = render(
      <I18nProvider>
        <I18nRichProbe />
      </I18nProvider>,
    );

    const single = view.getByTestId('single');
    expect(single.textContent).toBe(
      'Used in /mcp/bear. Letters, numbers, hyphens and underscores.',
    );
    expect(view.getByTestId('path-code').tagName).toBe('CODE');
    expect(view.getByTestId('path-code').textContent).toBe('/mcp/bear');

    const multi = view.getByTestId('multi');
    expect(view.getByTestId('entries-strong').tagName).toBe('STRONG');
    expect(view.getByTestId('mb-code').tagName).toBe('CODE');
    expect(multi.textContent).toContain('Keeps the newest 500 entries, 4 MiB in total,');
    // Unmatched placeholder stays visible as literal text.
    expect(multi.textContent).toContain('{kilobytes} KiB per entry.');
  });
});

const renderOperationsHarness = (
  initial: { snapshot?: AppSnapshot | null; doc?: Document | null; updateBusy?: boolean } = {},
) => {
  let bridge!: OperationsBridge;

  render(
    <I18nProvider>
      <OperationsHarnessComponent
        initialSnapshot={initial.snapshot ?? null}
        initialDoc={initial.doc ?? null}
        initialUpdateBusy={initial.updateBusy ?? false}
        onSync={(next) => {
          bridge = next;
        }}
      />
    </I18nProvider>,
  );

  return {
    run: (...args: Parameters<OperationsBridge['run']>) => bridge.run(...args),
    runUpdate: (...args: Parameters<OperationsBridge['runUpdate']>) => bridge.runUpdate(...args),
    getState: () => bridge.state,
    setDocLocal: (next: Document) => {
      act(() => {
        bridge.setDocLocal(next);
      });
    },
    bumpEditSequence: () => {
      bridge.bumpEditSequence();
    },
    bumpQuitGeneration: () => {
      bridge.bumpQuitGeneration();
    },
    setUpdateBusyDirectly: (value: boolean) => {
      act(() => {
        bridge.setUpdateBusyDirectly(value);
      });
    },
  };
};

describe('useOperations', () => {
  test('run sets busy during execution, applies returned snapshot and clean doc on save, and clears busy', async () => {
    const initialText = makeConfigText();
    const savedText = makeConfigText({
      bear: { command: '/usr/bin/env' },
    });
    const harness = renderOperationsHarness({
      doc: { text: initialText, revision: 'rev-1', dirty: true },
    });
    const pending = deferred<AppResult<AppSnapshot | null>>();

    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = harness.run(() => pending.promise, 'saved', true, true, initialText);
    });

    expect(harness.getState().busy).toBe(true);
    expect(harness.getState().error).toBeNull();
    expect(harness.getState().generation).toBe(1);

    const nextSnapshot = makeSnapshot({ configText: savedText, revision: 'rev-2' });
    await act(async () => {
      pending.resolve({ ok: true, value: nextSnapshot });
      expect(await runPromise).toBe(true);
    });

    expect(harness.getState().busy).toBe(false);
    expect(harness.getState().generation).toBe(2);
    expect(harness.getState().snapshot).toEqual(nextSnapshot);
    expect(harness.getState().doc).toEqual({
      text: savedText,
      revision: 'rev-2',
      dirty: false,
    });
  });

  test('run with saved=false updates snapshot without overwriting doc', async () => {
    const localDoc: Document = { text: '{"draft":true}', revision: 'rev-1', dirty: true };
    const harness = renderOperationsHarness({ doc: localDoc });
    const nextSnapshot = makeSnapshot({ revision: 'rev-2', running: true });

    let ok = false;
    await act(async () => {
      ok = await harness.run(async () => ({ ok: true, value: nextSnapshot }), '', false);
    });

    expect(ok).toBe(true);
    expect(harness.getState().snapshot).toEqual(nextSnapshot);
    expect(harness.getState().doc).toEqual(localDoc);
  });

  test('stale-write protection (C-15): concurrent local raw-config edit is not clobbered by in-flight save', async () => {
    const submittedText = makeConfigText({ first: { command: '/bin/echo' } });
    const newerLocalEdit = makeConfigText({
      first: { command: '/bin/echo' },
      second: { command: '/bin/cat' },
    });
    const harness = renderOperationsHarness({
      doc: { text: submittedText, revision: 'rev-1', dirty: true },
    });
    const pending = deferred<AppResult<AppSnapshot | null>>();

    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = harness.run(() => pending.promise, '', true, true, submittedText);
    });

    // User edits raw config while the earlier save is still in flight.
    harness.setDocLocal({ text: newerLocalEdit, revision: 'rev-1', dirty: true });

    const serverSnapshot = makeSnapshot({ configText: submittedText, revision: 'rev-2' });
    await act(async () => {
      pending.resolve({ ok: true, value: serverSnapshot });
      expect(await runPromise).toBe(true);
    });

    expect(harness.getState().snapshot).toEqual(serverSnapshot);
    expect(harness.getState().doc).toEqual({
      text: newerLocalEdit,
      revision: 'rev-2',
      dirty: true,
    });
  });

  test('stale-write protection marks dirty false if newer local text matches saved configText', async () => {
    const submittedText = makeConfigText();
    const harness = renderOperationsHarness({
      doc: { text: submittedText, revision: 'rev-1', dirty: true },
    });
    const pending = deferred<AppResult<AppSnapshot | null>>();

    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = harness.run(() => pending.promise, '', true, true, submittedText);
    });

    // Advance editSequence without diverging from final server text.
    harness.bumpEditSequence();

    const serverSnapshot = makeSnapshot({ configText: submittedText, revision: 'rev-2' });
    await act(async () => {
      pending.resolve({ ok: true, value: serverSnapshot });
      expect(await runPromise).toBe(true);
    });

    expect(harness.getState().doc).toEqual({
      text: submittedText,
      revision: 'rev-2',
      dirty: false,
    });
  });

  test('run surfaces localized error for ok:false results (draft vs non-draft) and rejected promises', async () => {
    const t = translator('en_US');
    const harness = renderOperationsHarness();

    await act(async () => {
      const ok = await harness.run(
        async () => ({ ok: false, error: { code: 'StaleRevision', message: 'Revision changed' } }),
        '',
        true,
        true,
      );
      expect(ok).toBe(false);
    });
    expect(harness.getState().busy).toBe(false);
    expect(harness.getState().error).toBe(
      t('operations.saveFailed', { error: 'StaleRevision: Revision changed' }),
    );

    await act(async () => {
      const ok = await harness.run(
        async () => ({ ok: false, error: { code: 'ListenerFailure', message: 'Port in use' } }),
        '',
        false,
        false,
      );
      expect(ok).toBe(false);
    });
    expect(harness.getState().error).toBe('ListenerFailure: Port in use');

    await act(async () => {
      const ok = await harness.run(async () => {
        throw new Error('bridge disconnected');
      });
      expect(ok).toBe(false);
    });
    expect(harness.getState().busy).toBe(false);
    expect(harness.getState().error).toBe(t('operations.nativeFailed'));
  });

  test('quitGeneration guard prevents post-quit resolutions and rejections from mutating state', async () => {
    const initialSnapshot = makeSnapshot({ revision: 'rev-1' });
    const initialDoc: Document = {
      text: initialSnapshot.gateway.configText,
      revision: 'rev-1',
      dirty: false,
    };
    const harness = renderOperationsHarness({ snapshot: initialSnapshot, doc: initialDoc });

    // Resolution after quitGeneration increments.
    const resolvePending = deferred<AppResult<AppSnapshot | null>>();
    let resolvePromise!: Promise<boolean>;
    act(() => {
      resolvePromise = harness.run(() => resolvePending.promise, '', true, true, initialDoc.text);
    });
    const genWhileRunning = harness.getState().generation;
    harness.bumpQuitGeneration();

    await act(async () => {
      resolvePending.resolve({
        ok: true,
        value: makeSnapshot({ revision: 'rev-99', running: true }),
      });
      expect(await resolvePromise).toBe(false);
    });

    expect(harness.getState().busy).toBe(false);
    expect(harness.getState().generation).toBe(genWhileRunning);
    expect(harness.getState().snapshot?.gateway.revision).toBe('rev-1');
    expect(harness.getState().doc).toEqual(initialDoc);
    expect(harness.getState().error).toBeNull();

    // Rejection after quitGeneration increments.
    const rejectPending = deferred<AppResult<AppSnapshot | null>>();
    let rejectPromise!: Promise<boolean>;
    act(() => {
      rejectPromise = harness.run(() => rejectPending.promise);
    });
    harness.bumpQuitGeneration();

    await act(async () => {
      rejectPending.reject(new Error('native bridge closed'));
      expect(await rejectPromise).toBe(false);
    });

    expect(harness.getState().busy).toBe(false);
    expect(harness.getState().error).toBeNull();
  });

  test('runUpdate handles concurrency lock, snapshot merge, error formatting, and quitGeneration guard', async () => {
    const t = translator('en_US');
    const initialSnapshot = makeSnapshot({ revision: 'rev-1' });
    const harness = renderOperationsHarness({ snapshot: initialSnapshot });

    // Re-entry blocked while updateBusy is true.
    harness.setUpdateBusyDirectly(true);
    let called = false;
    await act(async () => {
      const ok = await harness.runUpdate(async () => {
        called = true;
        return {
          ok: true,
          value: makeUpdateStatus({ phase: 'available', availableVersion: '1.0.0' }),
        };
      });
      expect(ok).toBe(false);
    });
    expect(called).toBe(false);
    harness.setUpdateBusyDirectly(false);

    // Normal success merges UpdateStatus into snapshot.
    const pending = deferred<AppResult<UpdateStatus>>();
    let updatePromise!: Promise<boolean>;
    act(() => {
      updatePromise = harness.runUpdate(() => pending.promise);
    });
    expect(harness.getState().updateBusy).toBe(true);

    const nextUpdate = makeUpdateStatus({ phase: 'available', availableVersion: '1.0.0' });
    await act(async () => {
      pending.resolve({ ok: true, value: nextUpdate });
      expect(await updatePromise).toBe(true);
    });
    expect(harness.getState().updateBusy).toBe(false);
    expect(harness.getState().snapshot?.update).toEqual(nextUpdate);

    // Non-ok error result.
    await act(async () => {
      const ok = await harness.runUpdate(async () => ({
        ok: false,
        error: { code: 'UpdateFailed', message: 'Feed unreachable' },
      }));
      expect(ok).toBe(false);
    });
    expect(harness.getState().error).toBe('UpdateFailed: Feed unreachable');

    // Rejected promise.
    await act(async () => {
      const ok = await harness.runUpdate(async () => {
        throw new Error('network down');
      });
      expect(ok).toBe(false);
    });
    expect(harness.getState().error).toBe(t('operations.updateFailed'));

    // Quit-generation guard suppresses update mutation.
    const postQuit = deferred<AppResult<UpdateStatus>>();
    let postQuitPromise!: Promise<boolean>;
    act(() => {
      postQuitPromise = harness.runUpdate(() => postQuit.promise);
    });
    harness.bumpQuitGeneration();
    await act(async () => {
      postQuit.resolve({
        ok: true,
        value: makeUpdateStatus({ phase: 'ready', availableVersion: '2.0.0' }),
      });
      expect(await postQuitPromise).toBe(false);
    });
    expect(harness.getState().updateBusy).toBe(false);
    expect(harness.getState().snapshot?.update.availableVersion).toBe('1.0.0');
  });
});

const renderGatewayContext = (client: AppClient) => {
  let latest!: GatewayViewValue;
  const view = render(
    <I18nProvider>
      <GatewayViewProvider client={client}>
        <GatewayContextProbe
          onSync={(value) => {
            latest = value;
          }}
        />
      </GatewayViewProvider>
    </I18nProvider>,
  );
  return {
    get ctx() {
      return latest;
    },
    unmount: view.unmount,
  };
};

describe('GatewayViewProvider and useGatewayView', () => {
  test('throws when useGatewayView is called outside GatewayViewProvider', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(() => render(<BareGatewayConsumer />)).toThrow(
        'useGatewayView must be used within a GatewayViewProvider',
      );
    } finally {
      console.error = originalError;
    }
  });

  test('hydrates snapshot, doc, config, updateState, and locale on mount and tracks unsaved checker', async () => {
    const initialText = makeConfigText({
      alpha: { command: '/usr/bin/env', args: ['node'], disabled: false },
    });
    const initialSnapshot = makeSnapshot({
      configPath: '/Users/test/mcp.jsonc',
      configFormat: 'jsonc',
      configText: initialText,
      revision: 'rev-1',
      locale: 'en_US',
      update: { phase: 'available', availableVersion: '0.10.0' },
    });
    const mockBundle = createMockAppClient(initialSnapshot);
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.snapshot).not.toBeNull();
    });

    expect(mockBundle.calls.snapshot).toBe(1);
    expect(harness.ctx.snapshot).toEqual(initialSnapshot);
    expect(harness.ctx.doc).toEqual({
      text: initialText,
      revision: 'rev-1',
      dirty: false,
    });
    expect(harness.ctx.format).toBe('jsonc');
    expect(harness.ctx.filename).toBe('mcp.jsonc');
    expect(harness.ctx.updateState?.phase).toBe('available');
    expect(harness.ctx.updateState?.availableVersion).toBe('0.10.0');
    expect(harness.ctx.existingNames.has('alpha')).toBe(true);
    expect(document.documentElement.lang).toBe('en-US');
    expect(unsavedRawConfigChecker()).toBe(false);

    // Pushing a snapshot with a different locale syncs I18nProvider and documentElement.lang.
    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          configPath: '/Users/test/mcp.jsonc',
          configFormat: 'jsonc',
          configText: initialText,
          revision: 'rev-1',
          locale: 'de_DE',
        }),
      );
    });
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('de-DE');
    });

    act(() => {
      harness.ctx.setDoc({ text: `${initialText}\n`, revision: 'rev-1', dirty: true });
    });
    expect(unsavedRawConfigChecker()).toBe(true);

    harness.unmount();
    expect(unsavedRawConfigChecker()).toBe(false);
    expect(mockBundle.snapshotListenerCount()).toBe(0);
    expect(mockBundle.menuListenerCount()).toBe(0);
  });

  test('surfaces error when initial client.snapshot() fails or rejects', async () => {
    const t = translator('en_US');
    const errBundle = createMockAppClient(makeSnapshot(), {
      snapshot: async () => ({
        ok: false,
        error: { code: 'ConfigIO', message: 'Permission denied' },
      }),
    });
    const errHarness = renderGatewayContext(errBundle.client);
    await waitFor(() => {
      expect(errHarness.ctx.error).toBe('ConfigIO: Permission denied');
    });
    errHarness.unmount();

    const rejectBundle = createMockAppClient(makeSnapshot(), {
      snapshot: async () => {
        throw new Error('disconnected');
      },
    });
    const rejectHarness = renderGatewayContext(rejectBundle.client);
    await waitFor(() => {
      expect(rejectHarness.ctx.error).toBe(t('app.statusUnavailable'));
    });
  });

  test('push onSnapshotChanged updates clean doc and updateState, but preserves dirty RawConfig edits (C-09)', async () => {
    const initialText = makeConfigText({ alpha: { command: '/bin/echo' } });
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.doc?.revision).toBe('rev-1');
    });

    // Clean push updates snapshot, updateState, and doc.
    const cleanPushText = makeConfigText({
      alpha: { command: '/bin/echo' },
      beta: { url: 'http://127.0.0.1:9000/mcp' },
    });
    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          configText: cleanPushText,
          revision: 'rev-2',
          update: { phase: 'downloading', availableVersion: '0.11.0' },
        }),
      );
    });

    expect(harness.ctx.doc).toEqual({
      text: cleanPushText,
      revision: 'rev-2',
      dirty: false,
    });
    expect(harness.ctx.updateState?.phase).toBe('downloading');
    expect(harness.ctx.stale).toBe(false);

    // Local dirty RawConfig edit must survive subsequent snapshot pushes and mark stale=true.
    const dirtyEdit = `${cleanPushText}\n// local draft`;
    act(() => {
      harness.ctx.setDoc({ text: dirtyEdit, revision: 'rev-2', dirty: true });
    });

    const externalPushText = makeConfigText({ gamma: { command: '/bin/true' } });
    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          configText: externalPushText,
          revision: 'rev-3',
          update: { phase: 'ready', availableVersion: '0.11.0' },
        }),
      );
    });

    expect(harness.ctx.snapshot?.gateway.revision).toBe('rev-3');
    expect(harness.ctx.updateState?.phase).toBe('ready');
    expect(harness.ctx.doc).toEqual({
      text: dirtyEdit,
      revision: 'rev-2',
      dirty: true,
    });
    expect(harness.ctx.stale).toBe(true);
  });

  test('push onSnapshotChanged does not clobber doc while serverEditor modal is open', async () => {
    const initialText = makeConfigText({ alpha: { command: '/bin/echo' } });
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config).not.toBeNull();
    });

    act(() => {
      harness.ctx.openServerEditor('alpha');
    });
    expect(harness.ctx.activeModal?.kind).toBe('serverEditor');

    const pushedText = makeConfigText({ alpha: { command: '/bin/ls' } });
    act(() => {
      mockBundle.emitSnapshot(makeSnapshot({ configText: pushedText, revision: 'rev-2' }));
    });

    expect(harness.ctx.snapshot?.gateway.revision).toBe('rev-2');
    expect(harness.ctx.doc?.text).toBe(initialText);
    expect(harness.ctx.doc?.revision).toBe('rev-1');
  });

  test('onMenuCommand routes tabs, raw config, new server editor, updates modal, and gateway reload', async () => {
    const initialText = makeConfigText({ alpha: { command: '/bin/echo' } });
    let confirmDiscardAnswer = false;
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
      {
        confirmDiscard: async () => {
          mockBundle.calls.confirmDiscard += 1;
          return { ok: true, value: confirmDiscardAnswer };
        },
      },
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config).not.toBeNull();
    });

    act(() => {
      mockBundle.emitMenuCommand('tab:logs');
    });
    expect(harness.ctx.tab).toBe('logs');

    act(() => {
      mockBundle.emitMenuCommand('tab:settings');
    });
    expect(harness.ctx.tab).toBe('settings');
    expect(harness.ctx.rawOpen).toBe(false);

    act(() => {
      mockBundle.emitMenuCommand('tab:raw-config');
    });
    expect(harness.ctx.tab).toBe('settings');
    expect(harness.ctx.rawOpen).toBe(true);

    act(() => {
      mockBundle.emitMenuCommand('updates:open');
    });
    await waitFor(() => {
      expect(harness.ctx.activeModal).toEqual({ kind: 'updates' });
    });

    act(() => {
      harness.ctx.closeModal();
    });
    expect(harness.ctx.activeModal).toBeNull();

    act(() => {
      mockBundle.emitMenuCommand('server:add');
    });
    expect(harness.ctx.tab).toBe('overview');
    expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
    expect(harness.ctx.editor?.original).toBeNull();

    act(() => {
      harness.ctx.closeModal();
      harness.ctx.setDoc({ text: '{"dirty":true}', revision: 'rev-1', dirty: true });
    });

    // Reload while dirty: user cancels discard -> snapshot is not re-fetched, draft stays dirty.
    confirmDiscardAnswer = false;
    await act(async () => {
      mockBundle.emitMenuCommand('gateway:reload');
      await Promise.resolve();
    });
    expect(mockBundle.calls.confirmDiscard).toBe(1);
    expect(mockBundle.calls.snapshot).toBe(1);
    expect(harness.ctx.dirty).toBe(true);

    // Reload while dirty: user confirms discard -> snapshot reloads and clears dirty flag.
    confirmDiscardAnswer = true;
    await act(async () => {
      mockBundle.emitMenuCommand('gateway:reload');
    });
    await waitFor(() => {
      expect(harness.ctx.dirty).toBe(false);
    });
    expect(mockBundle.calls.confirmDiscard).toBe(2);
    expect(mockBundle.calls.snapshot).toBe(2);
    expect(harness.ctx.doc?.text).toBe(initialText);

    act(() => {
      mockBundle.emitMenuCommand('tab:overview');
    });
    expect(harness.ctx.tab).toBe('overview');
  });

  test('toggleServer flips disabled and immediately commits via client.saveConfig (D-01)', async () => {
    const initialText = makeConfigText({
      alpha: { command: '/bin/echo', disabled: false },
    });
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config?.mcpServers.alpha?.disabled).toBe(false);
    });

    await act(async () => {
      await harness.ctx.toggleServer('alpha', true);
    });

    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    expect(mockBundle.calls.saveConfig[0]?.expectedRevision).toBe('rev-1');
    const savedDisabled = JSON.parse(mockBundle.calls.saveConfig[0]?.text ?? '{}') as ConfigFile;
    expect(savedDisabled.mcpServers.alpha?.disabled).toBe(true);
    expect(harness.ctx.config?.mcpServers.alpha?.disabled).toBe(true);
    expect(harness.ctx.dirty).toBe(false);

    await act(async () => {
      await harness.ctx.toggleServer('alpha', false);
    });

    expect(mockBundle.calls.saveConfig).toHaveLength(2);
    expect(mockBundle.calls.saveConfig[1]?.expectedRevision).toBe('rev-2');
    const savedEnabled = JSON.parse(mockBundle.calls.saveConfig[1]?.text ?? '{}') as ConfigFile;
    expect(savedEnabled.mcpServers.alpha?.disabled).toBe(false);
    expect(harness.ctx.config?.mcpServers.alpha?.disabled).toBe(false);

    // Refuses to commit while raw config is dirty.
    act(() => {
      harness.ctx.setDoc({ text: `${initialText}\n`, revision: 'rev-3', dirty: true });
    });
    await act(async () => {
      await harness.ctx.toggleServer('alpha', true);
    });
    expect(mockBundle.calls.saveConfig).toHaveLength(2);
  });

  test('deleteServer confirms via client.confirmDeleteServer before persisting deletion via saveConfig (D-01)', async () => {
    const initialText = makeConfigText({
      alpha: { command: '/bin/echo' },
      beta: { url: 'http://127.0.0.1:9000/mcp' },
    });
    let allowDelete = false;
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
      {
        confirmDeleteServer: async (params) => {
          mockBundle.calls.confirmDeleteServer.push(params);
          return { ok: true, value: allowDelete };
        },
      },
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.existingNames.size).toBe(2);
    });

    // Cancelled confirmation does not persist.
    await act(async () => {
      await harness.ctx.deleteServer('alpha');
    });
    expect(mockBundle.calls.confirmDeleteServer).toEqual([{ name: 'alpha' }]);
    expect(mockBundle.calls.saveConfig).toHaveLength(0);
    expect(harness.ctx.existingNames.has('alpha')).toBe(true);

    // Accepted confirmation removes only the target server and persists.
    allowDelete = true;
    await act(async () => {
      await harness.ctx.deleteServer('alpha');
    });
    expect(mockBundle.calls.confirmDeleteServer).toEqual([{ name: 'alpha' }, { name: 'alpha' }]);
    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    const saved = JSON.parse(mockBundle.calls.saveConfig[0]?.text ?? '{}') as ConfigFile;
    expect(Object.keys(saved.mcpServers)).toEqual(['beta']);
    expect(harness.ctx.existingNames.has('alpha')).toBe(false);
    expect(harness.ctx.existingNames.has('beta')).toBe(true);
  });

  test('applyServer validates SAFE_NAME (Plan 035) and rejects invalid names without calling saveConfig', async () => {
    const t = translator('en_US');
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: makeConfigText({ alpha: { command: '/bin/echo' } }) }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config).not.toBeNull();
    });

    const invalidNames = [
      '',
      '   ',
      'bad name',
      'foo/bar',
      '-starts-with-dash',
      '__proto__',
      'constructor',
    ];

    for (const badName of invalidNames) {
      act(() => {
        harness.ctx.openServerEditor();
      });
      act(() => {
        harness.ctx.changeEditor({ name: badName, command: '/bin/echo' });
      });
      await act(async () => {
        await harness.ctx.applyServer(makeFormEvent());
      });

      expect(harness.ctx.editorError).toBe(t('app.serverFieldsInvalid'));
      expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
      expect(mockBundle.calls.saveConfig).toHaveLength(0);
    }
  });

  test('applyServer rejects duplicate server names on add and rename (C-17) without calling saveConfig', async () => {
    const t = translator('en_US');
    const initialText = makeConfigText({
      alpha: { command: '/bin/echo' },
      beta: { url: 'http://127.0.0.1:9000/mcp' },
    });
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.existingNames.size).toBe(2);
    });

    // Adding a new server whose name collides with existing `alpha`.
    act(() => {
      harness.ctx.openServerEditor();
    });
    act(() => {
      harness.ctx.changeEditor({ name: 'alpha', command: '/bin/true' });
    });
    await act(async () => {
      await harness.ctx.applyServer(makeFormEvent());
    });

    expect(harness.ctx.editorError).toBe(t('app.serverExists'));
    expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
    expect(mockBundle.calls.saveConfig).toHaveLength(0);

    // Renaming existing `alpha` to collide with existing `beta`.
    act(() => {
      harness.ctx.openServerEditor('alpha');
    });
    act(() => {
      harness.ctx.changeEditor({ name: 'beta' });
    });
    await act(async () => {
      await harness.ctx.applyServer(makeFormEvent());
    });

    expect(harness.ctx.editorError).toBe(t('app.serverExists'));
    expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
    expect(mockBundle.calls.saveConfig).toHaveLength(0);
  });

  test('applyServer rejects empty custom token and invalid key-value rows without calling saveConfig', async () => {
    const t = translator('en_US');
    const mockBundle = createMockAppClient(makeSnapshot());
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config).not.toBeNull();
    });

    // Empty custom token (`''` instead of `undefined`) is rejected.
    act(() => {
      harness.ctx.openServerEditor();
    });
    act(() => {
      harness.ctx.changeEditor({ name: 'gamma', command: '/bin/echo', token: '' });
    });
    await act(async () => {
      await harness.ctx.applyServer(makeFormEvent());
    });
    expect(harness.ctx.editorError).toBe(t('app.serverKeyEmpty'));
    expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
    expect(mockBundle.calls.saveConfig).toHaveLength(0);

    // Duplicate env keys are rejected.
    act(() => {
      harness.ctx.changeEditor({
        token: undefined,
        env: [createKeyValueRow('FOO', '1'), createKeyValueRow('FOO', '2')],
      });
    });
    await act(async () => {
      await harness.ctx.applyServer(makeFormEvent());
    });
    expect(harness.ctx.editorError).toBe(t('app.environmentInvalid'));
    expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
    expect(mockBundle.calls.saveConfig).toHaveLength(0);
  });

  test('applyServer adds a new server, updates/renames an existing server, and keeps modal open if save fails', async () => {
    const initialText = makeConfigText({
      alpha: { command: '/bin/echo', args: ['hi'] },
    });
    let failNextSave = false;
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
    );
    const originalSave = mockBundle.client.saveConfig;
    mockBundle.client.saveConfig = async (params) => {
      if (failNextSave) {
        mockBundle.calls.saveConfig.push(params);
        return { ok: false, error: { code: 'InvalidConfig', message: 'Bad URL' } };
      }
      return originalSave(params);
    };

    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.existingNames.has('alpha')).toBe(true);
    });

    // Add a new HTTP server.
    act(() => {
      harness.ctx.openServerEditor();
    });
    act(() => {
      harness.ctx.changeEditor({
        name: 'remote_api',
        type: 'http',
        url: 'http://127.0.0.1:9001/mcp',
        headers: [createKeyValueRow('X-Client', 'test')],
      });
    });
    await act(async () => {
      await harness.ctx.applyServer(makeFormEvent());
    });

    expect(harness.ctx.activeModal).toBeNull();
    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    expect(mockBundle.calls.saveConfig[0]?.expectedRevision).toBe('rev-1');
    const afterAdd = JSON.parse(mockBundle.calls.saveConfig[0]?.text ?? '{}') as ConfigFile;
    expect(afterAdd.mcpServers.remote_api).toMatchObject({
      url: 'http://127.0.0.1:9001/mcp',
      headers: { 'X-Client': 'test' },
      disabled: false,
    });
    expect(harness.ctx.snapshot?.gateway.revision).toBe('rev-2');

    // Sync local doc to saved snapshot before subsequent editor action.
    act(() => {
      harness.ctx.reloadFromDisk();
    });
    expect(harness.ctx.existingNames.has('remote_api')).toBe(true);

    // Rename existing `alpha` -> `alpha_v2` and update command.
    act(() => {
      harness.ctx.openServerEditor('alpha');
    });
    act(() => {
      harness.ctx.changeEditor({ name: 'alpha_v2', command: '/usr/bin/env', args: ['bun'] });
    });
    await act(async () => {
      await harness.ctx.applyServer(makeFormEvent());
    });

    expect(harness.ctx.activeModal).toBeNull();
    expect(mockBundle.calls.saveConfig).toHaveLength(2);
    expect(mockBundle.calls.saveConfig[1]?.expectedRevision).toBe('rev-2');
    const afterRename = JSON.parse(mockBundle.calls.saveConfig[1]?.text ?? '{}') as ConfigFile;
    expect(afterRename.mcpServers.alpha).toBeUndefined();
    expect(afterRename.mcpServers.alpha_v2).toMatchObject({
      command: '/usr/bin/env',
      args: ['bun'],
    });
    expect(afterRename.mcpServers.remote_api).toBeDefined();

    // Failed save keeps serverEditor open and surfaces error.
    act(() => {
      harness.ctx.reloadFromDisk();
    });
    failNextSave = true;
    act(() => {
      harness.ctx.openServerEditor('remote_api');
    });
    act(() => {
      harness.ctx.changeEditor({ url: 'ftp://invalid' });
    });
    await act(async () => {
      await harness.ctx.applyServer(makeFormEvent());
    });

    expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
    expect(harness.ctx.error).toContain('InvalidConfig: Bad URL');
  });

  test('configurationLocked during update restarting closes updates modal and blocks mutations', async () => {
    const initialText = makeConfigText({ alpha: { command: '/bin/echo' } });
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: 'rev-1' }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config).not.toBeNull();
    });

    act(() => {
      harness.ctx.openUpdatesModal();
    });
    await waitFor(() => {
      expect(harness.ctx.activeModal).toEqual({ kind: 'updates' });
    });

    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          configText: initialText,
          revision: 'rev-1',
          update: { phase: 'restarting' },
        }),
      );
    });

    await waitFor(() => {
      expect(harness.ctx.configurationLocked).toBe(true);
      expect(harness.ctx.activeModal).toBeNull();
    });

    act(() => {
      harness.ctx.openServerEditor('alpha');
    });
    expect(harness.ctx.activeModal).toBeNull();

    await act(async () => {
      await harness.ctx.toggleServer('alpha', true);
      await harness.ctx.deleteServer('alpha');
    });
    expect(mockBundle.calls.saveConfig).toHaveLength(0);
    expect(mockBundle.calls.confirmDeleteServer).toHaveLength(0);
  });
});
