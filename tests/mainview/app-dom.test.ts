import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { EditorView } from '@codemirror/view';
import { Layer } from 'effect';

import { AppLiveLayers, AppView } from '@mcp-gateway/mainview/effect-app/AppView';
import { GatewayRpc, WindowEnv } from '@mcp-gateway/mainview/effect-app/services';
import { CONFIG_TOO_LARGE, MAX_CONFIG_BYTES } from '@mcp-gateway/shared/config-document';
import { translator } from '@mcp-gateway/shared/i18n';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import {
  cleanupDom,
  fireEvent,
  flushDom,
  installDomEnvironment,
  mountEffectView,
  waitFor,
  within,
} from '../helpers/dom';
import {
  createMockAppClient,
  DEFAULT_REVISION,
  makeConfigText,
  makeSnapshot,
  SECOND_REVISION,
  setNavigatorLanguages,
} from '../helpers/mainview';

installDomEnvironment();

const t = translator('en_US');
const defaultLanguages = navigator.languages;

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const must = <T>(value: T | null | undefined, label = 'value'): T => {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
};

const mountApp = (client: AppClient) => {
  const envLayer = Layer.mergeAll(
    GatewayRpc.live(client, {
      onSnapshotChanged: client.onSnapshotChanged,
      onMenuCommand: client.onMenuCommand,
    }),
    WindowEnv.live,
  );
  const runtimeLayer = Layer.mergeAll(envLayer, AppLiveLayers.pipe(Layer.provide(envLayer)));
  return mountEffectView(AppView, {}, runtimeLayer);
};

const getCodeMirrorView = (container: HTMLElement) => {
  const cmEditor = must(
    container.querySelector('.raw-code-editor .cm-editor') as HTMLElement | null,
    '.cm-editor',
  );
  return must(EditorView.findFromDOM(cmEditor), 'EditorView');
};

beforeEach(() => {
  setNavigatorLanguages(['en-US']);
  document.title = 'MCP Gateway';
});

afterEach(async () => {
  await cleanupDom();
  setNavigatorLanguages(defaultLanguages);
  document.documentElement.lang = '';
});

describe('RawConfig CodeMirror 6 DOM integration (AttachCodeMirror)', () => {
  test('mounts CodeMirror with configText, syncs edits, runs debounced validation (ok, issue + Line N jump, syntax error, oversized, bridge error), and updates aria-invalid', async () => {
    const initialText = makeConfigText({
      bear: { command: '/usr/bin/env', args: ['bear'] },
    });
    let validateMode: 'ok' | 'issue' | 'reject' = 'ok';
    const mockBundle = createMockAppClient(
      makeSnapshot({ gateway: { configText: initialText, revision: DEFAULT_REVISION } }),
      {
        validateConfig: async (params) => {
          mockBundle.calls.validateConfig.push(params);
          if (validateMode === 'reject') {
            throw new Error('Bridge validation offline');
          }
          if (validateMode === 'issue') {
            const portIndex = params.text.indexOf('"port"');
            return {
              ok: true,
              value: {
                issue: {
                  message: 'Port must be between 1 and 65535.',
                  offset: portIndex >= 0 ? portIndex : 20,
                },
              },
            };
          }
          return { ok: true, value: { issue: null } };
        },
      },
    );

    const view = await mountApp(mockBundle.client);
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.settings') }));
    await view.findByText(t('raw.title'));

    fireEvent.click(must(view.container.querySelector('button.raw-heading'), 'raw-heading'));
    await waitFor(() => {
      expect(view.container.querySelector('.raw-code-editor .cm-editor') !== null).toBe(true);
    });
    const cmView = getCodeMirrorView(view.container);
    expect(cmView.state.doc.toString()).toBe(initialText);

    const saveButton = () =>
      view.getByRole('button', {
        name: t('raw.save', { filename: 'mcp.json' }),
      }) as HTMLButtonElement;
    const resetButton = () =>
      view.getByRole('button', { name: t('raw.reset') }) as HTMLButtonElement;
    const rawFeedback = () =>
      must(
        view.container.querySelector('.raw-panel [role="status"]') as HTMLElement | null,
        'raw feedback',
      );

    // Clean initial document validates after 300ms debounce, reports checked, keeps Save/Reset disabled.
    await waitFor(() => {
      expect(rawFeedback().textContent).toBe(t('raw.checked'));
    });
    expect(saveButton().disabled).toBe(true);
    expect(resetButton().disabled).toBe(true);

    // 1. CodeMirror edit marks dirty (echo suppressed without destroying editor), validates ok, enables Save.
    const editedValidText = makeConfigText(
      { bear: { command: '/usr/bin/env', args: ['bear'] } },
      { port: 9090 },
    );
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: editedValidText },
    });
    await flushDom();
    expect(resetButton().disabled).toBe(false);
    expect(getCodeMirrorView(view.container)).toBe(cmView);

    await waitFor(() => {
      expect(mockBundle.calls.validateConfig.at(-1)?.text).toBe(editedValidText);
      expect(rawFeedback().textContent).toBe(t('raw.checked'));
    });
    expect(saveButton().disabled).toBe(false);

    // 2. Validation issue with offset shows issue message, sets aria-invalid, disables Save, and Line N jumps selection.
    validateMode = 'issue';
    const portIssueText = makeConfigText({}, { port: 99999 });
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: portIssueText },
    });

    await waitFor(() => {
      expect(rawFeedback().textContent).toContain('Port must be between 1 and 65535.');
    });
    expect(saveButton().disabled).toBe(true);
    expect(cmView.contentDOM.getAttribute('aria-invalid')).toBe('true');

    const lineJumpBtn = view.getByRole('button', { name: /^Line \d+$/ });
    fireEvent.click(lineJumpBtn);
    await flushDom();
    const targetLineNumber = Number(lineJumpBtn.textContent?.replace('Line ', ''));
    expect(cmView.state.doc.lineAt(cmView.state.selection.main.anchor).number).toBe(
      targetLineNumber,
    );

    // 3. Local JSON syntax error reports issue without calling validateConfig.
    const callsBeforeSyntaxError = mockBundle.calls.validateConfig.length;
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: '{' },
    });

    await waitFor(() => {
      expect(rawFeedback().textContent).toContain('line 1');
    });
    expect(mockBundle.calls.validateConfig.length).toBe(callsBeforeSyntaxError);
    expect(saveButton().disabled).toBe(true);
    expect(cmView.contentDOM.getAttribute('aria-invalid')).toBe('true');

    // 4. Draft exceeding MAX_CONFIG_BYTES reports CONFIG_TOO_LARGE without calling validateConfig.
    const oversizedText = `"${'x'.repeat(MAX_CONFIG_BYTES + 16)}"`;
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: oversizedText },
    });
    await waitFor(() => {
      expect(rawFeedback().textContent).toBe(CONFIG_TOO_LARGE);
    });
    expect(mockBundle.calls.validateConfig.length).toBe(callsBeforeSyntaxError);
    expect(saveButton().disabled).toBe(true);

    // 5. Bridge rejection displays checkUnavailable while keeping Save enabled.
    validateMode = 'reject';
    const bridgeFallbackText = makeConfigText({}, { port: 8899 });
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: bridgeFallbackText },
    });
    await waitFor(() => {
      expect(rawFeedback().textContent).toBe(t('raw.checkUnavailable'));
    });
    expect(saveButton().disabled).toBe(false);
  });

  test('Format, Reset, Save, Import from Claude / Cursor (0, 1, 2 notices), and Schema reference popover', async () => {
    const compactJson = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${'a'.repeat(32)}"},"mcpServers":{}}`;
    let importedCount = 0;
    const mockBundle = createMockAppClient(
      makeSnapshot({ gateway: { configText: compactJson, revision: DEFAULT_REVISION } }),
      {
        importExternalServers: async (params) => {
          mockBundle.calls.importExternalServers.push(params);
          return {
            ok: true,
            value: {
              snapshot: makeSnapshot({
                gateway: { configText: compactJson, revision: SECOND_REVISION },
              }),
              importedCount,
            },
          };
        },
      },
    );

    const view = await mountApp(mockBundle.client);
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.settings') }));
    await view.findByText(t('raw.title'));

    fireEvent.click(must(view.container.querySelector('button.raw-heading'), 'raw-heading'));
    await waitFor(() => {
      expect(view.container.querySelector('.raw-code-editor .cm-editor') !== null).toBe(true);
    });
    const cmView = getCodeMirrorView(view.container);
    expect(cmView.state.doc.toString()).toBe(compactJson);

    // Schema reference popover toggles open and closed.
    const schemaBtn = view.getByRole('button', { name: 'Schema reference' });
    expect(schemaBtn.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.schema-popover') === null).toBe(true);
    expect(getCodeMirrorView(view.container)).toBe(cmView);

    fireEvent.click(schemaBtn);
    await flushDom();
    expect(schemaBtn.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.schema-popover')?.textContent).toContain(t('raw.intro'));

    fireEvent.click(schemaBtn);
    await flushDom();
    expect(schemaBtn.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.schema-popover') === null).toBe(true);

    // Import from Claude / Cursor displays 0, 1, and 2 imported server notices.
    const rawPanel = must(
      view.container.querySelector('.raw-panel') as HTMLElement | null,
      '.raw-panel',
    );
    const importBtn = within(rawPanel).getByRole('button', { name: 'Import from Claude / Cursor' });
    importedCount = 0;
    fireEvent.click(importBtn);
    await within(rawPanel).findByText('No new servers found in Claude Desktop or Cursor.');

    importedCount = 1;
    fireEvent.click(importBtn);
    await within(rawPanel).findByText('Imported 1 server from Claude Desktop / Cursor.');

    importedCount = 2;
    fireEvent.click(importBtn);
    await within(rawPanel).findByText('Imported 2 servers from Claude Desktop / Cursor.');

    // Format reformats compact JSON with 2-space indentation and enables Reset.
    fireEvent.click(view.getByRole('button', { name: t('raw.format') }));
    await waitFor(() => {
      expect(cmView.state.doc.toString()).toContain('\n  "gateway": {\n    "host": "127.0.0.1"');
    });
    const formattedText = cmView.state.doc.toString();
    const resetBtn = view.getByRole('button', { name: t('raw.reset') }) as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(false);

    // Reset confirms discard and restores clean on-disk text.
    fireEvent.click(resetBtn);
    await waitFor(() => {
      expect(mockBundle.calls.confirmDiscard).toBe(1);
      expect(cmView.state.doc.toString()).toBe(compactJson);
    });
    expect(resetBtn.disabled).toBe(true);

    // Format again, wait for debounced validation, and Save via client.saveConfig.
    fireEvent.click(view.getByRole('button', { name: t('raw.format') }));
    const saveBtn = view.getByRole('button', {
      name: t('raw.save', { filename: 'mcp.json' }),
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(mockBundle.calls.saveConfig).toHaveLength(1);
    });
    expect(mockBundle.calls.saveConfig[0]?.text).toBe(formattedText);
  });
});

describe('AppView DOM shell, native <dialog> focus restoration, and modal arbitration', () => {
  test('renders connecting state while snapshot loads, switches Overview/Settings/Logs tabs, and opens RawConfig from ConfigBlockerBar', async () => {
    const pendingSnapshot = deferred<AppResult<AppSnapshot>>();
    const mockBundle = createMockAppClient(makeSnapshot(), {
      snapshot: () => pendingSnapshot.promise,
    });

    const view = await mountApp(mockBundle.client);

    expect(view.getByText(t('app.connecting'))).toBeTruthy();
    expect(view.getByText(t('shell.network.loading'))).toBeTruthy();

    pendingSnapshot.resolve({
      ok: true,
      value: makeSnapshot({
        gateway: {
          configText: '{ invalid json',
          network: null,
          configError: {
            occurrenceId: 'cfg-err-1',
            code: 'InvalidConfig',
            message: 'Malformed JSON',
          },
        },
      }),
    });

    await waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('Malformed JSON');
    });
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('overview');
    expect(document.documentElement.lang).toBe('en-US');

    // Clicking Raw Configuration on ConfigBlockerBar switches to Settings and expands RawConfig.
    fireEvent.click(view.getByRole('button', { name: t('raw.title') }));
    await view.findByRole('heading', { level: 1, name: t('shell.title.settings') });
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('settings');
    const rawHeadingBtn = view.container.querySelector('button.raw-heading');
    expect(rawHeadingBtn?.getAttribute('aria-expanded')).toBe('true');

    // Navigate via sidebar buttons to Logs and back to Overview.
    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.logs') }));
    await view.findByRole('heading', { level: 1, name: t('shell.title.logs') });
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('logs');

    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.overview') }));
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('overview');
  });

  test('keeps a dismissed operationalError hidden across tab switches', async () => {
    const mockBundle = createMockAppClient(
      makeSnapshot({
        gateway: {
          operationalError: {
            occurrenceId: 'op-tab-1',
            code: 'ListenerFailure',
            message: 'Port already in use',
          },
        },
      }),
    );

    const view = await mountApp(mockBundle.client);
    await waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('Port already in use');
    });

    fireEvent.click(
      within(view.getByRole('alert')).getByRole('button', { name: t('common.dismissError') }),
    );
    await waitFor(() => {
      expect(view.queryByRole('alert') === null).toBe(true);
    });

    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.settings') }));
    await view.findByRole('heading', { level: 1, name: t('shell.title.settings') });
    expect(view.queryByRole('alert') === null).toBe(true);

    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.overview') }));
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });
    expect(view.queryByRole('alert') === null).toBe(true);
  });

  test('arbitrates single active modal across WhatsNew, Updates, KeyMigration, and ServerEditor, and restores native <dialog> focus', async () => {
    const mockBundle = createMockAppClient(
      makeSnapshot({
        whatsNew: '0.9.0',
        keyReminder: true,
        gateway: {
          keyMigration: { gateway: true, servers: [] },
        },
        update: {
          supported: true,
          phase: 'available',
          availableVersion: '0.10.0',
        },
      }),
    );

    const view = await mountApp(mockBundle.client);

    // 1. WhatsNew opens automatically while no other modal is active, and disables SidebarUpdates.
    await view.findByRole('dialog', { name: t('whatsNew.title', { version: '0.9.0' }) });
    const sidebarUpdateBtn = view.container.querySelector(
      'button.sidebar-updates-button',
    ) as HTMLButtonElement;
    expect(sidebarUpdateBtn.disabled).toBe(true);

    // 2. Requesting Updates via menu while WhatsNew is open defers Updates until WhatsNew closes.
    mockBundle.emitMenuCommand('updates:open');
    await flushDom();
    expect(view.getAllByRole('dialog')).toHaveLength(1);
    expect(
      view.getByRole('dialog', { name: t('whatsNew.title', { version: '0.9.0' }) }),
    ).toBeTruthy();

    // Closing WhatsNew calls dismissWhatsNew() and immediately promotes the queued Updates modal.
    fireEvent.click(view.getByRole('button', { name: t('whatsNew.done') }));
    await view.findByRole('dialog', { name: t('common.updates') });
    await waitFor(() => {
      expect(mockBundle.calls.dismissWhatsNew).toBe(1);
    });
    expect(view.getAllByRole('dialog')).toHaveLength(1);

    // Close Updates modal via Escape cancel event -> restores focus to fallback nav target.
    const fallbackNavButton = view.container.querySelector('[data-fallback-focus="true"]');
    const updatesDialog = view.getByRole('dialog', { name: t('common.updates') });
    updatesDialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(view.queryByRole('dialog') === null).toBe(true);
    });
    await waitFor(() => {
      expect(document.activeElement === fallbackNavButton).toBe(true);
    });

    // 3. Opening KeyMigration from focused Review keys button restores focus to opener on close.
    const reviewKeysBtn = view.getByRole('button', { name: t('keys.review') }) as HTMLButtonElement;
    reviewKeysBtn.focus();
    fireEvent.click(reviewKeysBtn);
    await view.findByRole('dialog', { name: t('keys.title') });
    expect(view.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: t('common.closeDialog') }));
    await waitFor(() => {
      expect(view.queryByRole('dialog') === null).toBe(true);
    });
    await waitFor(() => {
      expect(document.activeElement === reviewKeysBtn).toBe(true);
    });

    // 4. Opening ServerEditor via menu command with no focused opener restores [data-fallback-focus] on close.
    (document.activeElement as HTMLElement | null)?.blur?.();
    mockBundle.emitMenuCommand('server:add');
    await view.findByRole('dialog', { name: t('editor.addTitle') });
    expect(view.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: t('common.closeDialog') }));
    await waitFor(() => {
      expect(view.queryByRole('dialog') === null).toBe(true);
    });
    await waitFor(() => {
      expect(document.activeElement === fallbackNavButton).toBe(true);
    });
  });
});
