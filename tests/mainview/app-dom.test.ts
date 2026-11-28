import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { undo, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { Effect, Layer } from 'effect';

import { AppLiveLayers, AppRoot, AppView } from '@mcp-gateway/mainview/effect-app/AppView';
import { isWindowDragTarget } from '@mcp-gateway/mainview/effect-app/chrome';
import { GatewayRpc, WindowEnv } from '@mcp-gateway/mainview/effect-app/services';
import { alertClasses } from '@mcp-gateway/mainview/effect-ui';
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

  test('preserves concatenated text, cursor offset, and undo history across rapid synchronous CodeMirror edits', async () => {
    const initialJson = JSON.stringify(
      {
        gateway: { host: '127.0.0.1', port: 8787, token: 'a'.repeat(64) },
        mcpServers: {
          demo: { command: '/usr/bin/env', args: ['hello'] },
        },
      },
      null,
      2,
    );
    const mockBundle = createMockAppClient(
      makeSnapshot({ gateway: { configText: initialJson, revision: DEFAULT_REVISION } }),
    );
    const view = await mountApp(mockBundle.client);
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.settings') }));
    await view.findByRole('heading', { level: 1, name: t('shell.title.settings') });
    fireEvent.click(must(view.container.querySelector('button.raw-heading'), 'raw-heading'));
    await waitFor(() => {
      expect(view.container.querySelector('.raw-code-editor .cm-editor') !== null).toBe(true);
    });

    const cmView = getCodeMirrorView(view.container);
    const insertAt = initialJson.indexOf('"hello"') + '"hello'.length;
    expect(insertAt).toBeGreaterThan(0);

    // Dispatch multiple synchronous CodeMirror transactions back-to-back before awaiting flush.
    cmView.dispatch({
      changes: { from: insertAt, insert: '-one' },
      selection: { anchor: insertAt + 4 },
    });
    cmView.dispatch({
      changes: { from: insertAt + 4, insert: '-two' },
      selection: { anchor: insertAt + 8 },
    });
    cmView.dispatch({
      changes: { from: insertAt + 8, insert: '-three' },
      selection: { anchor: insertAt + 14 },
    });

    await flushDom();
    await flushDom();

    const expectedText = initialJson.replace('"hello"', '"hello-one-two-three"');
    const expectedCursor = insertAt + 14;

    expect(cmView.state.doc.toString()).toBe(expectedText);
    expect(cmView.state.selection.main.head).toBe(expectedCursor);
    expect(undoDepth(cmView.state)).toBeGreaterThanOrEqual(1);

    // AppView reflects dirty state (Reset button enabled) and would save the concatenated text.
    const resetBtn = view.getByRole('button', { name: t('raw.reset') }) as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(false);

    // Undo cleanly reverts edits in CodeMirror.
    expect(undo(cmView)).toBe(true);
    await flushDom();
    expect(cmView.state.doc.toString()).not.toBe(expectedText);
    expect(cmView.state.doc.toString()).toBe(initialJson);
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

    // Close Updates modal via Escape cancel event -> restores focus to [data-sidebar-updates-trigger].
    const fallbackNavButton = view.container.querySelector('[data-fallback-focus="true"]');
    const updatesDialog = view.getByRole('dialog', { name: t('common.updates') });
    updatesDialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(view.queryByRole('dialog') === null).toBe(true);
    });
    await waitFor(() => {
      expect(document.activeElement === sidebarUpdateBtn).toBe(true);
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

  test('shows an error alert instead of crashing when toggling a Settings switch on an invalid on-disk config with a valid unsaved RawConfig draft', async () => {
    const validDraft = makeConfigText({
      bear: { command: '/usr/bin/env', args: ['bear'] },
    });
    const mockBundle = createMockAppClient(
      makeSnapshot({
        gateway: {
          configText: '{ invalid json',
          configError: {
            occurrenceId: 'cfg-invalid-1',
            code: 'InvalidConfig',
            message: 'Malformed JSON',
          },
        },
      }),
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
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: validDraft },
    });

    // Wait for Settings switches to render from the valid unsaved draft
    const autoStartSwitch = (await view.findByRole('switch', {
      name: new RegExp(t('settings.autoStart')),
    })) as HTMLButtonElement;
    fireEvent.click(autoStartSwitch);

    await waitFor(() => {
      const alerts = view.getAllByRole('alert');
      expect(alerts.some((node) => (node.textContent ?? '').length > 0)).toBe(true);
    });
    expect(view.container.querySelector('main[data-tab="settings"]') !== null).toBe(true);
    expect(mockBundle.calls.saveConfig).toHaveLength(0);
  });

  test('resets ServerEditorView inputs cleanly when server:add arrives while editing an existing server', async () => {
    const initialText = makeConfigText({
      bear: { command: '/usr/bin/bear', args: ['--mcp'] },
    });
    const mockBundle = createMockAppClient(
      makeSnapshot({
        gateway: { configText: initialText, revision: DEFAULT_REVISION },
      }),
    );

    const view = await mountApp(mockBundle.client);
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    fireEvent.click(view.getByRole('button', { name: t('common.editServer') }));
    await view.findByRole('dialog', { name: t('common.editServer') });

    const nameInput = view.getByLabelText(t('editor.name')) as HTMLInputElement;
    expect(nameInput.value).toBe('bear');
    fireEvent.input(nameInput, { target: { value: 'bear-edited' } });
    await flushDom();
    expect(nameInput.value).toBe('bear-edited');

    mockBundle.emitMenuCommand('server:add');
    await view.findByRole('dialog', { name: t('editor.addTitle') });

    const freshNameInput = view.getByLabelText(t('editor.name')) as HTMLInputElement;
    const freshCommandInput = view.getByLabelText(t('editor.command')) as HTMLInputElement;
    expect(freshNameInput.value).toBe('');
    expect(freshCommandInput.value).toBe('');

    fireEvent.input(freshNameInput, { target: { value: 'notes' } });
    fireEvent.input(freshCommandInput, { target: { value: '/usr/bin/notes' } });
    await flushDom();
    fireEvent.click(view.getByRole('button', { name: t('editor.apply') }));

    await waitFor(() => {
      expect(mockBundle.calls.saveConfig).toHaveLength(1);
    });
    const saved = JSON.parse(mockBundle.calls.saveConfig[0]?.text ?? '{}') as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(saved.mcpServers?.bear?.command).toBe('/usr/bin/bear');
    expect(saved.mcpServers?.notes?.command).toBe('/usr/bin/notes');
  });

  test('prompts confirmDiscard on update restart when RawConfig is dirty and respects cancel vs confirm', async () => {
    const initialText = makeConfigText({});
    let confirmResult = false;
    const mockBundle = createMockAppClient(
      makeSnapshot({
        gateway: { configText: initialText, revision: DEFAULT_REVISION },
        update: {
          supported: true,
          phase: 'ready',
          availableVersion: '0.10.0',
        },
      }),
      {
        confirmDiscard: async () => {
          mockBundle.calls.confirmDiscard += 1;
          return { ok: true, value: confirmResult };
        },
      },
    );

    const view = await mountApp(mockBundle.client);
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    // Edit raw config so doc becomes dirty
    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.settings') }));
    await view.findByText(t('raw.title'));
    fireEvent.click(must(view.container.querySelector('button.raw-heading'), 'raw-heading'));
    await waitFor(() => {
      expect(view.container.querySelector('.raw-code-editor .cm-editor') !== null).toBe(true);
    });
    const cmView = getCodeMirrorView(view.container);
    const dirtyText = makeConfigText({}, { port: 9191 });
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: dirtyText },
    });
    await flushDom();

    // Cancel discard keeps draft and does not call updatesRestart
    const restartBtn = must(
      view.container.querySelector('[data-sidebar-updates-trigger]') as HTMLButtonElement | null,
      '[data-sidebar-updates-trigger]',
    );
    fireEvent.click(restartBtn);
    await waitFor(() => {
      expect(mockBundle.calls.confirmDiscard).toBe(1);
    });
    await flushDom();
    expect(mockBundle.calls.updatesRestart).toBe(0);
    expect(cmView.state.doc.toString()).toBe(dirtyText);

    // Confirm discard triggers updatesRestart
    confirmResult = true;
    fireEvent.click(restartBtn);
    await waitFor(() => {
      expect(mockBundle.calls.confirmDiscard).toBe(2);
      expect(mockBundle.calls.updatesRestart).toBe(1);
    });
  });

  test('AppRoot renders its role="alert" fallback on AppView failure and remounts AppView when Retry is clicked', async () => {
    const mockBundle = createMockAppClient(makeSnapshot());
    let attempts = 0;
    const envLayer = Layer.mergeAll(
      GatewayRpc.live(mockBundle.client, {
        onSnapshotChanged: mockBundle.client.onSnapshotChanged,
        onMenuCommand: mockBundle.client.onMenuCommand,
      }),
      WindowEnv.test({
        initialLanguages: () =>
          Effect.suspend(() => {
            attempts += 1;
            if (attempts === 1) {
              return Effect.die(new Error('Simulated AppView bootstrap defect'));
            }
            return Effect.succeed(['en-US']);
          }),
      }),
    );
    const runtimeLayer = Layer.mergeAll(envLayer, AppLiveLayers.pipe(Layer.provide(envLayer)));
    const view = await mountEffectView(AppRoot, {}, runtimeLayer);

    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');

    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });
    await waitFor(() => {
      expect(attempts).toBe(2);
    });
  });

  test('alertClasses uses flex layout and text-mac-label without conflicting grid/gap/text-mac-red tokens', () => {
    for (const kind of ['error', 'warning', 'success'] as const) {
      const tokens = alertClasses(kind).split(/\s+/);
      expect(tokens).toContain('flex');
      expect(tokens).toContain('items-center');
      expect(tokens).toContain('gap-2.5');
      expect(tokens).toContain('text-mac-label');
      expect(tokens).not.toContain('grid');
      expect(tokens).not.toContain('gap-0.5');
      expect(tokens).not.toContain('text-mac-red');
    }
  });

  test('omits dangling label[for] references and wires aria-describedby only to rendered help elements across SettingsView and ServerEditorView', async () => {
    const assertValidLabelsAndDescribedBy = (root: HTMLElement) => {
      const labelsWithFor = Array.from(root.querySelectorAll<HTMLLabelElement>('label[for]'));
      for (const label of labelsWithFor) {
        const targetId = label.getAttribute('for');
        expect(targetId).toBeTruthy();
        if (targetId) {
          expect(root.querySelector(`[id="${targetId}"]`) !== null).toBe(true);
        }
      }
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>('input[id], select[id], textarea[id]'),
      );
      for (const control of controls) {
        const id = control.getAttribute('id');
        if (!id) continue;
        const helpEl = root.querySelector(`[id="${id}-help"]`);
        const describedBy = control.getAttribute('aria-describedby');
        if (helpEl) {
          expect(describedBy).toBe(`${id}-help`);
        } else {
          expect(describedBy).toBeNull();
        }
      }
    };

    // 1. Plaintext gateway token + stdio & http ServerEditor modes
    const plainConfig = makeConfigText({
      bear: { command: '/usr/bin/bear', args: ['--mcp'], env: { FOO: 'bar' } },
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } },
    });
    const plainBundle = createMockAppClient(
      makeSnapshot({ gateway: { configText: plainConfig, revision: DEFAULT_REVISION } }),
    );
    const plainView = await mountApp(plainBundle.client);
    await plainView.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    // SettingsView with plaintext token
    const nav = plainView.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.settings') }));
    await plainView.findByRole('heading', { level: 1, name: t('shell.title.settings') });
    assertValidLabelsAndDescribedBy(plainView.container);
    expect(
      plainView.container.querySelector('#settings-port')?.getAttribute('aria-describedby'),
    ).toBeNull();
    expect(
      plainView.container.querySelector('#settings-address')?.getAttribute('aria-describedby'),
    ).toBe('settings-address-help');
    expect(
      plainView.container.querySelector('#settings-appearance')?.getAttribute('aria-describedby'),
    ).toBe('settings-appearance-help');
    expect(
      plainView.container.querySelector('#settings-language')?.getAttribute('aria-describedby'),
    ).toBe('settings-language-help');

    // ServerEditorView in stdio mode
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.overview') }));
    await plainView.findByRole('heading', { level: 1, name: t('shell.title.overview') });
    const editButtons = plainView.getAllByRole('button', { name: t('common.editServer') });
    fireEvent.click(must(editButtons[0], 'bear edit button'));
    await plainView.findByRole('dialog', { name: t('common.editServer') });
    assertValidLabelsAndDescribedBy(plainView.container);
    expect(plainView.container.querySelector('label[for="server-editor-args"]') === null).toBe(
      true,
    );
    expect(plainView.container.querySelector('label[for="server-editor-env"]') === null).toBe(true);

    // Switch to HTTP mode
    const transportSelect = must(
      plainView.container.querySelector('#server-editor-transport') as HTMLSelectElement | null,
      '#server-editor-transport',
    );
    fireEvent.change(transportSelect, { target: { value: 'http' } });
    await waitFor(() => {
      expect(plainView.container.querySelector('#server-editor-url') !== null).toBe(true);
    });
    assertValidLabelsAndDescribedBy(plainView.container);
    expect(plainView.container.querySelector('label[for="server-editor-headers"]') === null).toBe(
      true,
    );
    fireEvent.click(plainView.getByRole('button', { name: t('common.closeDialog') }));
    await waitFor(() => {
      expect(plainView.queryByRole('dialog') === null).toBe(true);
    });
    await cleanupDom();

    // 2. Stored Keychain tokenRef in both SettingsView and ServerEditorView
    const keychainConfig = JSON.stringify({
      gateway: { host: '127.0.0.1', port: 8787, tokenRef: 'keychain:gateway' },
      mcpServers: {
        vault: { command: '/usr/bin/vault', tokenRef: 'keychain:vault' },
      },
    });
    const kcBundle = createMockAppClient(
      makeSnapshot({ gateway: { configText: keychainConfig, revision: DEFAULT_REVISION } }),
    );
    const kcView = await mountApp(kcBundle.client);
    await kcView.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    // SettingsView stored tokenRef omits label[for="settings-token"]
    const kcNav = kcView.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(kcNav).getByRole('button', { name: t('shell.tab.settings') }));
    await kcView.findByRole('heading', { level: 1, name: t('shell.title.settings') });
    expect(kcView.container.querySelector('label[for="settings-token"]') === null).toBe(true);
    assertValidLabelsAndDescribedBy(kcView.container);

    // ServerEditorView stored tokenRef omits label[for="server-editor-key-stored"]
    fireEvent.click(within(kcNav).getByRole('button', { name: t('shell.tab.overview') }));
    await kcView.findByRole('heading', { level: 1, name: t('shell.title.overview') });
    fireEvent.click(kcView.getByRole('button', { name: t('common.editServer') }));
    await kcView.findByRole('dialog', { name: t('common.editServer') });
    expect(kcView.container.querySelector('label[for="server-editor-key-stored"]') === null).toBe(
      true,
    );
    assertValidLabelsAndDescribedBy(kcView.container);
  });

  test('restores focus to [data-sidebar-updates-trigger] when UpdatesView closes after menu open, and falls back when trigger is disabled', async () => {
    const mockBundle = createMockAppClient(
      makeSnapshot({
        update: {
          supported: true,
          phase: 'available',
          availableVersion: '0.10.0',
        },
      }),
    );

    const view = await mountApp(mockBundle.client);
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    const settingsTabBtn = within(nav).getByRole('button', {
      name: t('shell.tab.settings'),
    }) as HTMLButtonElement;
    const sidebarUpdateBtn = must(
      view.container.querySelector('[data-sidebar-updates-trigger]') as HTMLButtonElement | null,
      '[data-sidebar-updates-trigger]',
    );

    // 1. Focus another button, open updates via menu, close -> focus moves to sidebar updates trigger
    settingsTabBtn.focus();
    expect(document.activeElement === settingsTabBtn).toBe(true);
    mockBundle.emitMenuCommand('updates:open');
    await view.findByRole('dialog', { name: t('common.updates') });

    fireEvent.click(view.getByRole('button', { name: t('common.closeDialog') }));
    await waitFor(() => {
      expect(view.queryByRole('dialog') === null).toBe(true);
    });
    await waitFor(() => {
      expect(document.activeElement === sidebarUpdateBtn).toBe(true);
    });

    // 2. If [data-sidebar-updates-trigger] is disabled when Updates closes, fall back to opener
    settingsTabBtn.focus();
    mockBundle.emitMenuCommand('updates:open');
    await view.findByRole('dialog', { name: t('common.updates') });
    sidebarUpdateBtn.disabled = true;

    fireEvent.click(view.getByRole('button', { name: t('common.closeDialog') }));
    await waitFor(() => {
      expect(view.queryByRole('dialog') === null).toBe(true);
    });
    await waitFor(() => {
      expect(document.activeElement === settingsTabBtn).toBe(true);
    });
  });

  test('shell marks titlebar and sidebar with native drag attributes without Electrobun drag classes', async () => {
    const mockBundle = createMockAppClient(makeSnapshot());
    const view = await mountApp(mockBundle.client);
    await view.findByRole('heading', { level: 1, name: t('shell.title.overview') });

    expect(view.container.querySelector('.electrobun-webkit-app-region-drag')).toBeNull();
    expect(view.container.querySelector('.electrobun-webkit-app-region-no-drag')).toBeNull();

    const titlebar = must(view.container.querySelector('.window-titlebar'), '.window-titlebar');
    const sidebar = must(view.container.querySelector('.sidebar'), '.sidebar');
    const brandText = must(
      view.container.querySelector('.brand span:last-child')?.firstChild,
      'brand text',
    );
    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    const navButton = within(nav).getByRole('button', { name: t('shell.tab.overview') });
    const updatesWrapper = must(
      view.container.querySelector('.sidebar-updates'),
      '.sidebar-updates',
    );
    const updatesButton = must(
      view.container.querySelector('[data-sidebar-updates-trigger]'),
      '[data-sidebar-updates-trigger]',
    );
    const main = must(view.container.querySelector('main'), 'main');

    expect(isWindowDragTarget(titlebar)).toBe(true);
    expect(isWindowDragTarget(sidebar)).toBe(true);
    expect(isWindowDragTarget(brandText)).toBe(true);
    expect(isWindowDragTarget(nav)).toBe(false);
    expect(isWindowDragTarget(navButton)).toBe(false);
    expect(isWindowDragTarget(updatesWrapper)).toBe(false);
    expect(isWindowDragTarget(updatesButton)).toBe(false);
    expect(isWindowDragTarget(main)).toBe(false);
    expect(isWindowDragTarget(null)).toBe(false);
  });
});
