import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { act, render, renderHook, waitFor } from '@testing-library/react';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';

import type { Document, Editor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
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
import {
  createMockAppClient,
  DEFAULT_REVISION,
  makeConfigText,
  makeSnapshot,
  makeUpdateStatus,
  SECOND_REVISION,
  setNavigatorLanguages,
  THIRD_REVISION,
} from '../helpers/mainview';

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

const defaultLanguages = navigator.languages;

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
      expect(() => renderHook(() => useI18n())).toThrow(
        'useI18n must be used inside I18nProvider.',
      );
    } finally {
      console.error = originalError;
    }
  });

  test('renders children with en_US by default and syncs documentElement.lang', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });

    expect(result.current.locale).toBe('en_US');
    expect(document.documentElement.lang).toBe('en-US');
    expect(result.current.t('common.cancel')).toBe('Cancel');
    expect(result.current.t('common.quitApp', { app: 'MCP Gateway' })).toBe('Quit MCP Gateway');
  });

  test('initializes locale from navigator.languages', () => {
    setNavigatorLanguages(['fr-CA', 'en-US']);
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });

    expect(result.current.locale).toBe('fr_FR');
    expect(document.documentElement.lang).toBe('fr-FR');
    expect(result.current.t('common.cancel')).toBe('Annuler');
  });

  test('switches between fr_FR, de_DE, tr_TR, and en_US updating lang and localized strings', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });

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
        result.current.setLocale(entry.locale);
      });
      expect(result.current.locale).toBe(entry.locale);
      expect(document.documentElement.lang).toBe(entry.tag);
      expect(result.current.t('language.name')).toBe(entry.name);
      expect(result.current.t('overview.addServer')).toBe(entry.add);
    }
  });

  test('rich() substitutes React nodes while preserving surrounding text and unmatched placeholders', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    const view = render(
      <div>
        <p data-testid="single">
          {result.current.rich('editor.nameHelp', {
            path: <code data-testid="path-code">/mcp/bear</code>,
          })}
        </p>
        <p data-testid="multi">
          {result.current.rich('logs.limits', {
            entries: <strong data-testid="entries-strong">500</strong>,
            megabytes: <code data-testid="mb-code">4</code>,
          })}
        </p>
      </div>,
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
  const { result } = renderHook(
    () => {
      const quitGeneration = useRef(0);
      const generation = useRef(0);
      const editSequence = useRef(0);
      const [busy, setBusy] = useState(false);
      const [updateBusy, setUpdateBusy] = useState(initial.updateBusy ?? false);
      const [error, setError] = useState<string | null>(null);
      const [snapshot, setSnapshot] = useState<AppSnapshot | null>(initial.snapshot ?? null);
      const [doc, setDocState] = useState<Document | null>(initial.doc ?? null);
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

      return {
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
        setDocLocal: (next: Document) => {
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
      };
    },
    { wrapper: I18nProvider },
  );

  return {
    run: (...args: Parameters<ReturnType<typeof useOperations>['run']>) =>
      result.current.run(...args),
    runUpdate: (...args: Parameters<ReturnType<typeof useOperations>['runUpdate']>) =>
      result.current.runUpdate(...args),
    getState: () => result.current.state,
    setDocLocal: (next: Document) => {
      act(() => {
        result.current.setDocLocal(next);
      });
    },
    bumpEditSequence: () => {
      result.current.bumpEditSequence();
    },
    bumpQuitGeneration: () => {
      result.current.bumpQuitGeneration();
    },
    setUpdateBusyDirectly: (value: boolean) => {
      act(() => {
        result.current.setUpdateBusyDirectly(value);
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
      doc: { text: initialText, revision: DEFAULT_REVISION, dirty: true },
    });
    const pending = deferred<AppResult<AppSnapshot | null>>();

    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = harness.run(() => pending.promise, 'saved', true, true, initialText);
    });

    expect(harness.getState().busy).toBe(true);
    expect(harness.getState().error).toBeNull();
    expect(harness.getState().generation).toBe(1);

    const nextSnapshot = makeSnapshot({ configText: savedText, revision: SECOND_REVISION });
    await act(async () => {
      pending.resolve({ ok: true, value: nextSnapshot });
      expect(await runPromise).toBe(true);
    });

    expect(harness.getState().busy).toBe(false);
    expect(harness.getState().generation).toBe(2);
    expect(harness.getState().snapshot).toEqual(nextSnapshot);
    expect(harness.getState().doc).toEqual({
      text: savedText,
      revision: SECOND_REVISION,
      dirty: false,
    });
  });

  test('run with saved=false updates snapshot without overwriting doc', async () => {
    const localDoc: Document = { text: '{"draft":true}', revision: DEFAULT_REVISION, dirty: true };
    const harness = renderOperationsHarness({ doc: localDoc });
    const nextSnapshot = makeSnapshot({ revision: SECOND_REVISION, running: true });

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
      doc: { text: submittedText, revision: DEFAULT_REVISION, dirty: true },
    });
    const pending = deferred<AppResult<AppSnapshot | null>>();

    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = harness.run(() => pending.promise, '', true, true, submittedText);
    });

    // User edits raw config while the earlier save is still in flight.
    harness.setDocLocal({ text: newerLocalEdit, revision: DEFAULT_REVISION, dirty: true });

    const serverSnapshot = makeSnapshot({ configText: submittedText, revision: SECOND_REVISION });
    await act(async () => {
      pending.resolve({ ok: true, value: serverSnapshot });
      expect(await runPromise).toBe(true);
    });

    expect(harness.getState().snapshot).toEqual(serverSnapshot);
    expect(harness.getState().doc).toEqual({
      text: newerLocalEdit,
      revision: SECOND_REVISION,
      dirty: true,
    });
  });

  test('stale-write protection marks dirty false if newer local text matches saved configText', async () => {
    const submittedText = makeConfigText();
    const harness = renderOperationsHarness({
      doc: { text: submittedText, revision: DEFAULT_REVISION, dirty: true },
    });
    const pending = deferred<AppResult<AppSnapshot | null>>();

    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = harness.run(() => pending.promise, '', true, true, submittedText);
    });

    // Advance editSequence without diverging from final server text.
    harness.bumpEditSequence();

    const serverSnapshot = makeSnapshot({ configText: submittedText, revision: SECOND_REVISION });
    await act(async () => {
      pending.resolve({ ok: true, value: serverSnapshot });
      expect(await runPromise).toBe(true);
    });

    expect(harness.getState().doc).toEqual({
      text: submittedText,
      revision: SECOND_REVISION,
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
    const initialSnapshot = makeSnapshot({ revision: DEFAULT_REVISION });
    const initialDoc: Document = {
      text: initialSnapshot.gateway.configText,
      revision: DEFAULT_REVISION,
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
    expect(harness.getState().snapshot?.gateway.revision).toBe(DEFAULT_REVISION);
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
    const initialSnapshot = makeSnapshot({ revision: DEFAULT_REVISION });
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
  const { result, unmount } = renderHook(() => useGatewayView(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider>
        <GatewayViewProvider client={client}>{children}</GatewayViewProvider>
      </I18nProvider>
    ),
  });
  return {
    get ctx() {
      return result.current;
    },
    unmount,
  };
};

describe('GatewayViewProvider and useGatewayView', () => {
  test('throws when useGatewayView is called outside GatewayViewProvider', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useGatewayView())).toThrow(
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
      revision: DEFAULT_REVISION,
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
      revision: DEFAULT_REVISION,
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
          revision: DEFAULT_REVISION,
          locale: 'de_DE',
        }),
      );
    });
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('de-DE');
    });

    act(() => {
      harness.ctx.setDoc({ text: `${initialText}\n`, revision: DEFAULT_REVISION, dirty: true });
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
      makeSnapshot({ configText: initialText, revision: DEFAULT_REVISION }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.doc?.revision).toBe(DEFAULT_REVISION);
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
          revision: SECOND_REVISION,
          update: { phase: 'downloading', availableVersion: '0.11.0' },
        }),
      );
    });

    expect(harness.ctx.doc).toEqual({
      text: cleanPushText,
      revision: SECOND_REVISION,
      dirty: false,
    });
    expect(harness.ctx.updateState?.phase).toBe('downloading');
    expect(harness.ctx.stale).toBe(false);

    // Local dirty RawConfig edit must survive subsequent snapshot pushes and mark stale=true.
    const dirtyEdit = `${cleanPushText}\n// local draft`;
    act(() => {
      harness.ctx.setDoc({ text: dirtyEdit, revision: SECOND_REVISION, dirty: true });
    });

    const externalPushText = makeConfigText({ gamma: { command: '/bin/true' } });
    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          configText: externalPushText,
          revision: THIRD_REVISION,
          update: { phase: 'ready', availableVersion: '0.11.0' },
        }),
      );
    });

    expect(harness.ctx.snapshot?.gateway.revision).toBe(THIRD_REVISION);
    expect(harness.ctx.updateState?.phase).toBe('ready');
    expect(harness.ctx.doc).toEqual({
      text: dirtyEdit,
      revision: SECOND_REVISION,
      dirty: true,
    });
    expect(harness.ctx.stale).toBe(true);
  });

  test('push onSnapshotChanged does not clobber doc while serverEditor modal is open', async () => {
    const initialText = makeConfigText({ alpha: { command: '/bin/echo' } });
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: DEFAULT_REVISION }),
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
      mockBundle.emitSnapshot(makeSnapshot({ configText: pushedText, revision: SECOND_REVISION }));
    });

    expect(harness.ctx.snapshot?.gateway.revision).toBe(SECOND_REVISION);
    expect(harness.ctx.doc?.text).toBe(initialText);
    expect(harness.ctx.doc?.revision).toBe(DEFAULT_REVISION);
  });

  test('onMenuCommand routes tabs, raw config, new server editor, updates modal, and gateway reload', async () => {
    const initialText = makeConfigText({ alpha: { command: '/bin/echo' } });
    let confirmDiscardAnswer = false;
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: DEFAULT_REVISION }),
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
      harness.ctx.setDoc({ text: '{"dirty":true}', revision: DEFAULT_REVISION, dirty: true });
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
      makeSnapshot({ configText: initialText, revision: DEFAULT_REVISION }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config?.mcpServers.alpha?.disabled).toBe(false);
    });

    await act(async () => {
      await harness.ctx.toggleServer('alpha', true);
    });

    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    expect(mockBundle.calls.saveConfig[0]?.expectedRevision).toBe(DEFAULT_REVISION);
    const savedDisabled = JSON.parse(mockBundle.calls.saveConfig[0]?.text ?? '{}') as ConfigFile;
    expect(savedDisabled.mcpServers.alpha?.disabled).toBe(true);
    expect(harness.ctx.config?.mcpServers.alpha?.disabled).toBe(true);
    expect(harness.ctx.dirty).toBe(false);

    await act(async () => {
      await harness.ctx.toggleServer('alpha', false);
    });

    expect(mockBundle.calls.saveConfig).toHaveLength(2);
    expect(mockBundle.calls.saveConfig[1]?.expectedRevision).toBe(SECOND_REVISION);
    const savedEnabled = JSON.parse(mockBundle.calls.saveConfig[1]?.text ?? '{}') as ConfigFile;
    expect(savedEnabled.mcpServers.alpha?.disabled).toBe(false);
    expect(harness.ctx.config?.mcpServers.alpha?.disabled).toBe(false);

    // Refuses to commit while raw config is dirty.
    act(() => {
      harness.ctx.setDoc({ text: `${initialText}\n`, revision: THIRD_REVISION, dirty: true });
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
      makeSnapshot({ configText: initialText, revision: DEFAULT_REVISION }),
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

  test('applyServer rejects invalid SAFE_NAME, duplicate names, empty custom token, and invalid key-value rows without calling saveConfig', async () => {
    const t = translator('en_US');
    const mockBundle = createMockAppClient(
      makeSnapshot({
        configText: makeConfigText({
          alpha: { command: '/bin/echo' },
          beta: { url: 'http://127.0.0.1:9000/mcp' },
        }),
      }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.existingNames.size).toBe(2);
    });

    const cases: Array<{
      openName?: string;
      patch: Partial<Editor>;
      expectedError: string;
    }> = [
      ...['', '   ', 'bad name', 'foo/bar', '-starts-with-dash', '__proto__', 'constructor'].map(
        (badName) => ({
          patch: { name: badName, command: '/bin/echo' },
          expectedError: t('app.serverFieldsInvalid'),
        }),
      ),
      { patch: { name: 'alpha', command: '/bin/true' }, expectedError: t('app.serverExists') },
      { openName: 'alpha', patch: { name: 'beta' }, expectedError: t('app.serverExists') },
      {
        patch: { name: 'gamma', command: '/bin/echo', token: '' },
        expectedError: t('app.serverKeyEmpty'),
      },
      {
        patch: {
          name: 'gamma',
          command: '/bin/echo',
          env: [createKeyValueRow('FOO', '1'), createKeyValueRow('FOO', '2')],
        },
        expectedError: t('app.environmentInvalid'),
      },
    ];

    for (const entry of cases) {
      act(() => {
        harness.ctx.openServerEditor(entry.openName);
      });
      act(() => {
        harness.ctx.changeEditor(entry.patch);
      });
      await act(async () => {
        await harness.ctx.applyServer(makeFormEvent());
      });
      expect(harness.ctx.editorError).toBe(entry.expectedError);
      expect(harness.ctx.activeModal?.kind).toBe('serverEditor');
      expect(mockBundle.calls.saveConfig).toHaveLength(0);
    }
  });

  test('applyServer adds a new server, updates/renames an existing server, and keeps modal open if save fails', async () => {
    const initialText = makeConfigText({
      alpha: { command: '/bin/echo', args: ['hi'] },
    });
    let failNextSave = false;
    const mockBundle = createMockAppClient(
      makeSnapshot({ configText: initialText, revision: DEFAULT_REVISION }),
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
    expect(mockBundle.calls.saveConfig[0]?.expectedRevision).toBe(DEFAULT_REVISION);
    const afterAdd = JSON.parse(mockBundle.calls.saveConfig[0]?.text ?? '{}') as ConfigFile;
    expect(afterAdd.mcpServers.remote_api).toMatchObject({
      url: 'http://127.0.0.1:9001/mcp',
      headers: { 'X-Client': 'test' },
      disabled: false,
    });
    expect(harness.ctx.snapshot?.gateway.revision).toBe(SECOND_REVISION);

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
    expect(mockBundle.calls.saveConfig[1]?.expectedRevision).toBe(SECOND_REVISION);
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
      makeSnapshot({ configText: initialText, revision: DEFAULT_REVISION }),
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
          revision: DEFAULT_REVISION,
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

  test('requestUpdateRestart confirms discard when RawConfig is dirty and handles cancel, confirm, and failure', async () => {
    const t = translator('en_US');
    const initialText = makeConfigText({ alpha: { command: '/bin/echo' } });
    let discardOutcome: 'cancel' | 'confirm' | 'error' | 'throw' = 'cancel';

    const mockBundle = createMockAppClient(
      makeSnapshot({
        configText: initialText,
        revision: DEFAULT_REVISION,
        update: { phase: 'ready', availableVersion: '0.10.0' },
      }),
      {
        confirmDiscard: async () => {
          mockBundle.calls.confirmDiscard += 1;
          if (discardOutcome === 'throw') throw new Error('dialog unavailable');
          if (discardOutcome === 'error') {
            return {
              ok: false,
              error: { code: 'OperationFailed', message: 'Dialog failed' },
            };
          }
          return { ok: true, value: discardOutcome === 'confirm' };
        },
      },
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.config).not.toBeNull();
    });

    act(() => {
      harness.ctx.openUpdatesModal();
      harness.ctx.setDoc({ text: `${initialText}\n`, revision: DEFAULT_REVISION, dirty: true });
    });
    await waitFor(() => {
      expect(harness.ctx.activeModal).toEqual({ kind: 'updates' });
    });

    // 1. User cancels confirmDiscard -> updatesRestart is not called, modal remains open.
    discardOutcome = 'cancel';
    await act(async () => {
      await harness.ctx.requestUpdateRestart();
    });
    expect(mockBundle.calls.confirmDiscard).toBe(1);
    expect(mockBundle.calls.updatesRestart).toBe(0);
    expect(harness.ctx.activeModal).toEqual({ kind: 'updates' });

    // 2. confirmDiscard returns ok: false -> error is populated, updatesRestart is not called.
    discardOutcome = 'error';
    await act(async () => {
      await harness.ctx.requestUpdateRestart();
    });
    expect(mockBundle.calls.confirmDiscard).toBe(2);
    expect(mockBundle.calls.updatesRestart).toBe(0);
    expect(harness.ctx.error).toBe('OperationFailed: Dialog failed');

    // 3. confirmDiscard throws -> localized error is populated, updatesRestart is not called.
    discardOutcome = 'throw';
    await act(async () => {
      await harness.ctx.requestUpdateRestart();
    });
    expect(mockBundle.calls.confirmDiscard).toBe(3);
    expect(mockBundle.calls.updatesRestart).toBe(0);
    expect(harness.ctx.error).toBe(t('app.confirmUnavailable'));

    // 4. User confirms discard -> updates modal closes and updatesRestart is called.
    discardOutcome = 'confirm';
    await act(async () => {
      await harness.ctx.requestUpdateRestart();
    });
    expect(mockBundle.calls.confirmDiscard).toBe(4);
    expect(mockBundle.calls.updatesRestart).toBe(1);
    expect(harness.ctx.activeModal).toBeNull();
  });

  test('KeyUnavailable configError preserves parsed config when clean so Settings can repair token', async () => {
    const initialText = makeConfigText(
      { bear: { command: '/usr/bin/env' } },
      { token: undefined, tokenRef: 'gateway' },
    );
    const mockBundle = createMockAppClient(
      makeSnapshot({
        configText: initialText,
        gateway: {
          configError: {
            occurrenceId: 'key-err-1',
            code: 'KeyUnavailable',
            message: 'Keychain item could not be read',
          },
        },
      }),
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.snapshot).not.toBeNull();
    });

    expect(harness.ctx.dirty).toBe(false);
    expect(harness.ctx.config).not.toBeNull();
    expect(harness.ctx.config?.gateway.tokenRef).toBe('gateway');
    expect(harness.ctx.existingNames.has('bear')).toBe(true);
  });

  test('discardRawConfig, importExternalServers dirty/error guards, and migrateKeys update snapshot and doc', async () => {
    const initialText = makeConfigText({ bear: { command: '/usr/bin/env' } });
    let allowDiscard = false;
    let importShouldFail = false;

    const mockBundle = createMockAppClient(
      makeSnapshot({
        configText: initialText,
        revision: DEFAULT_REVISION,
        gateway: {
          keyMigration: { gateway: true, servers: ['bear'] },
        },
      }),
      {
        confirmDiscard: async () => {
          mockBundle.calls.confirmDiscard += 1;
          return { ok: true, value: allowDiscard };
        },
        importExternalServers: async (params) => {
          mockBundle.calls.importExternalServers.push(params);
          if (importShouldFail) {
            return {
              ok: false,
              error: { code: 'ImportFailed', message: 'Could not read external file' },
            };
          }
          const importedSnapshot = makeSnapshot({
            configText: makeConfigText({
              bear: { command: '/usr/bin/env' },
              cursor_srv: { command: 'npx' },
            }),
            revision: SECOND_REVISION,
          });
          mockBundle.emitSnapshot(importedSnapshot);
          return { ok: true, value: { snapshot: importedSnapshot, importedCount: 1 } };
        },
      },
    );
    const harness = renderGatewayContext(mockBundle.client);

    await waitFor(() => {
      expect(harness.ctx.doc).not.toBeNull();
    });

    // Make doc dirty.
    act(() => {
      harness.ctx.setDoc({ text: '{"dirty":true}', revision: DEFAULT_REVISION, dirty: true });
    });
    expect(harness.ctx.dirty).toBe(true);

    // importExternalServers returns null immediately without calling client when doc is dirty.
    let importedCount: number | null = 99;
    await act(async () => {
      importedCount = await harness.ctx.importExternalServers();
    });
    expect(importedCount).toBeNull();
    expect(mockBundle.calls.importExternalServers).toHaveLength(0);

    // discardRawConfig does not reload when confirmDiscard returns false.
    allowDiscard = false;
    await act(async () => {
      await harness.ctx.discardRawConfig();
    });
    expect(mockBundle.calls.confirmDiscard).toBe(1);
    expect(harness.ctx.dirty).toBe(true);

    // discardRawConfig reloads clean configText when confirmDiscard returns true.
    allowDiscard = true;
    await act(async () => {
      await harness.ctx.discardRawConfig();
    });
    expect(mockBundle.calls.confirmDiscard).toBe(2);
    expect(harness.ctx.dirty).toBe(false);
    expect(harness.ctx.doc?.text).toBe(initialText);

    // importExternalServers surfaces error and returns null when client returns ok: false.
    importShouldFail = true;
    await act(async () => {
      importedCount = await harness.ctx.importExternalServers();
    });
    expect(importedCount).toBeNull();
    expect(mockBundle.calls.importExternalServers).toEqual([
      { expectedRevision: DEFAULT_REVISION },
    ]);
    expect(harness.ctx.error).toBe('ImportFailed: Could not read external file');

    // importExternalServers succeeds when clean and ok: true.
    importShouldFail = false;
    await act(async () => {
      importedCount = await harness.ctx.importExternalServers();
    });
    expect(importedCount).toBe(1);
    expect(harness.ctx.doc?.revision).toBe(SECOND_REVISION);

    // migrateKeys({ gateway: true, servers: ['bear'] }) invokes client.migrateKeys and updates snapshot & doc.
    let migratedOk = false;
    await act(async () => {
      migratedOk = await harness.ctx.migrateKeys({ gateway: true, servers: ['bear'] });
    });
    expect(migratedOk).toBe(true);
    expect(mockBundle.calls.migrateKeys).toEqual([
      {
        gateway: true,
        servers: ['bear'],
        expectedRevision: SECOND_REVISION,
      },
    ]);
    expect(harness.ctx.snapshot?.gateway.keyMigration).toEqual({ gateway: false, servers: [] });
    expect(harness.ctx.doc?.dirty).toBe(false);
  });
});
