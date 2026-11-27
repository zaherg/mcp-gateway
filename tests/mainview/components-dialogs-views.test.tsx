import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createRef, type ReactNode, type RefObject, useState } from 'react';

import { ConfigBlockerBar } from '@mcp-gateway/mainview/components/ConfigBlockerBar';
import { GatewayToggle } from '@mcp-gateway/mainview/components/GatewayToggle';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@mcp-gateway/mainview/components/mac/native-select';
import { SidebarUpdates } from '@mcp-gateway/mainview/components/SidebarUpdates';
import { Alert, CheckboxRow, Field, Modal, Toggle } from '@mcp-gateway/mainview/components/ui';
import { KeyMigration } from '@mcp-gateway/mainview/dialogs/KeyMigration';
import {
  createKeyValueRow,
  type Editor,
  emptyEditor,
  ServerEditor,
} from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { I18nProvider } from '@mcp-gateway/mainview/i18n';
import { Logs } from '@mcp-gateway/mainview/Logs';
import { type Locale, translator } from '@mcp-gateway/shared/i18n';
import type {
  AppClient,
  AppResult,
  AppSnapshot,
  MenuCommand,
  UpdateStatus,
} from '@mcp-gateway/shared/rpc';
import type {
  ConfigFile,
  GatewaySnapshot,
  KeyMigration as KeyMigrationSlots,
  LogEntry,
  LogPage,
} from '@mcp-gateway/shared/types';
import { cleanupDom, installDomEnvironment } from '../helpers/dom';

installDomEnvironment();

// Mock `@mcp-gateway/mainview/rpc` (rather than `@mcp-gateway/mainview/client`) so
// `new Electroview({ rpc })` is never evaluated outside a live Electrobun WebView and
// `tests/mainview/hooks-and-context.test.tsx`'s `@mcp-gateway/mainview/client` mock never collides.
mock.module('@mcp-gateway/mainview/rpc', () => ({
  client: {} as AppClient,
  setUnsavedRawConfigChecker: () => {},
  onSnapshotChanged: () => () => {},
  onMenuCommand: () => () => {},
}));

const { GatewayViewProvider } = await import('@mcp-gateway/mainview/context/GatewayViewContext');
const { WhatsNew } = await import('@mcp-gateway/mainview/dialogs/WhatsNew');
const { Overview } = await import('@mcp-gateway/mainview/views/Overview');
const { Settings } = await import('@mcp-gateway/mainview/views/Settings');
const { Updates } = await import('@mcp-gateway/mainview/views/Updates');
const { App } = await import('@mcp-gateway/mainview/App');

const t = translator('en_US');
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

// `tests/helpers/dom.ts` imports `@testing-library/react` before `installDomEnvironment()`,
// so React DOM may initialize with `isInputEventSupported = false` (its input-event polyfill
// watches `focus` + `keyup` via `getInstIfValueChanged`). Focusing, setting value, and firing
// `keyUp` triggers React's `onChange` exactly once in both native and polyfill modes.
const setInputValue = (input: HTMLInputElement, value: string): void => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyUp(input, { key: 'Unidentified' });
};

// Click the wrapping <label> rather than the nested Base UI <span role="switch"> so the click
// triggers Base UI's hidden checkbox once instead of bubbling from span -> label -> checkbox twice.
const getToggleControl = (container: HTMLElement, label: string): HTMLElement => {
  const strong = within(container).getByText(label);
  const labelEl = strong.closest('label');
  if (!labelEl) throw new Error(`Toggle label not found for "${label}"`);
  return labelEl;
};

const must = <T,>(value: T | null | undefined, label = 'value'): T => {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
};

const lastSavedConfig = (bundle: MockClientBundle): ConfigFile =>
  JSON.parse(must(bundle.calls.saveConfig.at(-1), 'saveConfig call').text) as ConfigFile;

const StatefulServerEditor = ({
  initial,
  existingNames,
  fallbackFocus,
  onClose,
  onSubmitted,
}: {
  initial: Editor;
  existingNames: ReadonlySet<string>;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSubmitted: (editor: Editor) => void;
}) => {
  const [editor, setEditor] = useState<Editor>(initial);
  const [editorError, setEditorError] = useState<string | null>(null);
  return (
    <ServerEditor
      editor={editor}
      existingNames={existingNames}
      editorError={editorError}
      configurationLocked={false}
      fallbackFocus={fallbackFocus}
      onChange={(patch) => setEditor((prev) => ({ ...prev, ...patch }))}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmitted(editor);
      }}
      onDismissError={() => setEditorError(null)}
    />
  );
};

const renderWithI18n = (ui: ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

const renderWithGateway = (client: AppClient, ui: ReactNode) =>
  render(
    <I18nProvider>
      <GatewayViewProvider client={client}>{ui}</GatewayViewProvider>
    </I18nProvider>,
  );

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

const makeConfigText = (
  servers: Record<string, unknown> = {},
  gatewayOverrides: Record<string, unknown> = {},
): string =>
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

const makeGatewaySnapshot = (overrides: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({
  configPath: '/tmp/mcp.json',
  configFormat: 'json',
  configText: makeConfigText(),
  revision: 'rev-1',
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

interface SnapshotOverrides {
  gateway?: Partial<GatewaySnapshot>;
  login?: Partial<AppSnapshot['login']>;
  update?: Partial<UpdateStatus>;
  whatsNew?: string | null;
  keyReminder?: boolean;
  locale?: Locale;
}

const makeSnapshot = (overrides: SnapshotOverrides = {}): AppSnapshot => {
  const locale = overrides.locale ?? 'en_US';
  return {
    gateway: makeGatewaySnapshot(overrides.gateway),
    login: { enabled: false, supported: true, error: null, ...overrides.login },
    update: makeUpdateStatus(overrides.update),
    whatsNew: overrides.whatsNew ?? null,
    keyReminder: overrides.keyReminder ?? false,
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
  calls: {
    saveConfig: Array<{ text: string; expectedRevision: string }>;
    confirmDeleteServer: Array<{ name: string }>;
    restartServer: Array<{ name: string }>;
    testServer: Array<{ name: string; expectedRevision: string }>;
    revealConfig: number;
    openConfigInEditor: number;
    importExternalServers: Array<{ expectedRevision: string }>;
    dismissKeyReminder: number;
    dismissWhatsNew: number;
    setLanguage: Array<{ preference: string }>;
    updatesCheck: number;
    updatesInstall: number;
    updatesRestart: number;
    updatesSetAutomatic: Array<{ automatic: boolean }>;
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
    saveConfig: [],
    confirmDeleteServer: [],
    restartServer: [],
    testServer: [],
    revealConfig: 0,
    openConfigInEditor: 0,
    importExternalServers: [],
    dismissKeyReminder: 0,
    dismissWhatsNew: 0,
    setLanguage: [],
    updatesCheck: 0,
    updatesInstall: 0,
    updatesRestart: 0,
    updatesSetAutomatic: [],
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
    snapshot: async () => ({ ok: true, value: currentSnapshot }),
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
      emitSnapshot(updated);
      return { ok: true, value: updated };
    },
    confirmDeleteServer: async (params) => {
      calls.confirmDeleteServer.push(params);
      return { ok: true, value: true };
    },
    confirmDiscard: async () => ({ ok: true, value: true }),
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
      const next: AppSnapshot = {
        ...currentSnapshot,
        gateway: { ...currentSnapshot.gateway, running: true },
      };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    stop: async () => {
      const next: AppSnapshot = {
        ...currentSnapshot,
        gateway: { ...currentSnapshot.gateway, running: false },
      };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    restartServer: async (params) => {
      calls.restartServer.push(params);
      return { ok: true, value: currentSnapshot };
    },
    testServer: async (params) => {
      calls.testServer.push(params);
      return { ok: true, value: { protocolVersion: '2025-11-25' } };
    },
    migrateKeys: async () => ({ ok: true, value: currentSnapshot }),
    dismissKeyReminder: async () => {
      calls.dismissKeyReminder += 1;
      const next: AppSnapshot = { ...currentSnapshot, keyReminder: false };
      emitSnapshot(next);
      return { ok: true, value: next };
    },
    validateConfig: async () => ({ ok: true, value: { issue: null } }),
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
    updatesDownload: () => unusedError('updatesDownload'),
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
      const nextLocale: Locale = params.preference === 'system' ? 'en_US' : params.preference;
      const next: AppSnapshot = {
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
    calls,
  };
};

beforeEach(() => {
  setNavigatorLanguages(['en-US']);
  document.title = 'MCP Gateway';
});

afterEach(() => {
  cleanupDom();
  setNavigatorLanguages(defaultLanguages);
  document.documentElement.lang = '';
});

describe('Shared UI components (src/mainview/components/ui.tsx)', () => {
  test('Alert renders severity styling, roles, optional action buttons, and calls onDismiss', () => {
    const onDismiss = mock(() => {});
    const onAction = mock(() => {});

    const view = renderWithI18n(
      <>
        <Alert onDismiss={onDismiss}>
          <strong>Error title</strong> Port already in use
          <button type="button" onClick={onAction}>
            Retry
          </button>
        </Alert>
        <Alert kind="warning" label="Close warning" onDismiss={onDismiss}>
          Warning notice
        </Alert>
        <Alert kind="success" label="Close success" onDismiss={onDismiss}>
          Saved successfully
        </Alert>
      </>,
    );

    const alerts = view.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.textContent).toContain('Error title');
    expect(alerts[0]?.textContent).toContain('Port already in use');
    expect(alerts[0]?.className).toContain('bg-mac-red/8');
    expect(alerts[1]?.textContent).toContain('Warning notice');
    expect(alerts[1]?.className).toContain('bg-mac-yellow/12');

    const status = view.getByRole('status');
    expect(status.textContent).toContain('Saved successfully');
    expect(status.className).toContain('bg-mac-fill-quaternary');

    fireEvent.click(within(must(alerts[0])).getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(must(alerts[0])).getByRole('button', { name: t('common.dismissError') }),
    );
    fireEvent.click(within(must(alerts[1])).getByRole('button', { name: 'Close warning' }));
    fireEvent.click(within(status).getByRole('button', { name: 'Close success' }));
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });

  test('Field links label to nested Input and NativeSelect by id and wires help text via aria-describedby', () => {
    const view = renderWithI18n(
      <>
        <Field label="Server Name" help="Letters and hyphens only.">
          <div className="wrapper">
            <Input value="bear" onChange={() => {}} />
          </div>
        </Field>
        <Field label="Transport">
          <NativeSelect value="stdio" onChange={() => {}}>
            <NativeSelectOption value="stdio">Local</NativeSelectOption>
            <NativeSelectOption value="http">HTTP</NativeSelectOption>
          </NativeSelect>
        </Field>
      </>,
    );

    const input = view.getByLabelText('Server Name') as HTMLInputElement;
    expect(input.value).toBe('bear');
    expect(input.id).not.toBe('');
    const helpId = input.getAttribute('aria-describedby');
    expect(helpId).toBe(`${input.id}-help`);
    expect(document.getElementById(helpId ?? '')?.textContent).toBe('Letters and hyphens only.');

    const select = view.getByLabelText('Transport') as HTMLSelectElement;
    expect(select.value).toBe('stdio');
    expect(select.getAttribute('aria-describedby')).toBeNull();
  });

  test('Toggle invokes onChange on click and keyboard activation and respects disabled', () => {
    const onChange = mock((_checked: boolean) => {});
    const onDisabledChange = mock((_checked: boolean) => {});

    const view = renderWithI18n(
      <>
        <Toggle
          label="Keep Mac awake"
          description="Prevents idle sleep while running."
          checked={false}
          onChange={onChange}
        />
        <Toggle
          label="Locked option"
          description="Cannot be changed."
          checked={true}
          disabled={true}
          onChange={onDisabledChange}
        />
      </>,
    );

    expect(view.getByText('Prevents idle sleep while running.')).toBeTruthy();

    const switches = view.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    const activeSwitch = must(switches[0]);
    const disabledSwitch = must(switches[1]);

    expect(activeSwitch.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(activeSwitch);
    expect(onChange).toHaveBeenCalledWith(true);

    // Keyboard activation via Space on the switch control.
    fireEvent.keyDown(activeSwitch, { key: ' ' });
    fireEvent.keyUp(activeSwitch, { key: ' ' });
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);

    expect(disabledSwitch.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(disabledSwitch);
    fireEvent.keyDown(disabledSwitch, { key: ' ' });
    fireEvent.keyUp(disabledSwitch, { key: ' ' });
    expect(onDisabledChange).toHaveBeenCalledTimes(0);
  });

  test('CheckboxRow invokes onChange on click and keyboard toggle and respects disabled', () => {
    const onChange = mock((_checked: boolean) => {});
    const onDisabledChange = mock((_checked: boolean) => {});

    const view = renderWithI18n(
      <>
        <CheckboxRow label="Start disabled" checked={false} disabled={false} onChange={onChange} />
        <CheckboxRow
          label="Legacy protocol"
          checked={true}
          disabled={true}
          onChange={onDisabledChange}
        />
      </>,
    );

    const checkboxes = view.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    const activeCheckbox = must(checkboxes[0]);
    const disabledCheckbox = must(checkboxes[1]);

    expect(activeCheckbox.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(activeCheckbox);
    expect(onChange).toHaveBeenCalledWith(true);

    fireEvent.keyDown(activeCheckbox, { key: ' ' });
    fireEvent.keyUp(activeCheckbox, { key: ' ' });
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);

    expect(disabledCheckbox.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(disabledCheckbox);
    fireEvent.keyDown(disabledCheckbox, { key: ' ' });
    fireEvent.keyUp(disabledCheckbox, { key: ' ' });
    expect(onDisabledChange).toHaveBeenCalledTimes(0);
  });

  test('Modal opens via showModal, dismisses via Escape/close when idle, locks both when busy (C-18), and restores focus', () => {
    const fallbackFocus = createRef<HTMLButtonElement>();
    const onCloseIdle = mock(() => {});

    // Render opener first, focus it, then mount Modal so opener is captured.
    const view = renderWithI18n(
      <>
        <button type="button" ref={fallbackFocus}>
          Fallback
        </button>
        <button type="button">Opener</button>
      </>,
    );
    const opener = view.getByRole('button', { name: 'Opener' }) as HTMLButtonElement;
    opener.focus();

    view.rerender(
      <I18nProvider>
        <button type="button" ref={fallbackFocus}>
          Fallback
        </button>
        <button type="button">Opener</button>
        <Modal title="Idle Modal" onClose={onCloseIdle} fallbackFocus={fallbackFocus} busy={false}>
          <p>Idle body</p>
        </Modal>
      </I18nProvider>,
    );

    const dialog = view.getByRole('dialog', { name: 'Idle Modal' }) as HTMLDialogElement;
    expect(dialog.open).toBe(true);

    const cancelEvent = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onCloseIdle).toHaveBeenCalledTimes(1);

    const closeBtn = view.getByRole('button', {
      name: t('common.closeDialog'),
    }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);
    fireEvent.click(closeBtn);
    expect(onCloseIdle).toHaveBeenCalledTimes(2);

    // Re-render with busy=true: Escape cancel event and X button must both be blocked.
    const onCloseBusy = mock(() => {});
    view.rerender(
      <I18nProvider>
        <button type="button" ref={fallbackFocus}>
          Fallback
        </button>
        <Modal title="Busy Modal" onClose={onCloseBusy} fallbackFocus={fallbackFocus} busy={true}>
          <p>Busy body</p>
        </Modal>
      </I18nProvider>,
    );

    const busyDialog = view.getByRole('dialog', { name: 'Busy Modal' }) as HTMLDialogElement;
    const busyCancelEvent = new Event('cancel', { cancelable: true });
    busyDialog.dispatchEvent(busyCancelEvent);
    expect(busyCancelEvent.defaultPrevented).toBe(true);
    expect(onCloseBusy).toHaveBeenCalledTimes(0);

    const busyCloseBtn = view.getByRole('button', {
      name: t('common.closeDialog'),
    }) as HTMLButtonElement;
    expect(busyCloseBtn.disabled).toBe(true);
    fireEvent.click(busyCloseBtn);
    expect(onCloseBusy).toHaveBeenCalledTimes(0);

    // Unmounting when opener is gone restores focus to fallbackFocus.
    view.rerender(
      <I18nProvider>
        <button type="button" ref={fallbackFocus}>
          Fallback
        </button>
      </I18nProvider>,
    );
    expect(document.activeElement === fallbackFocus.current).toBe(true);
  });
});

describe('ConfigBlockerBar, GatewayToggle, and SidebarUpdates', () => {
  test('ConfigBlockerBar renders nothing when healthy, renders configError/stale details, and triggers actions', () => {
    const onOpenRawConfig = mock(() => {});
    const onReloadFromDisk = mock(() => {});

    const view = renderWithI18n(
      <ConfigBlockerBar
        configError={null}
        stale={false}
        onOpenRawConfig={onOpenRawConfig}
        onReloadFromDisk={onReloadFromDisk}
      />,
    );
    expect(view.queryByRole('alert')).toBeNull();

    // Parse/validation config error opens raw config.
    view.rerender(
      <I18nProvider>
        <ConfigBlockerBar
          configError={{
            occurrenceId: 'occ-1',
            code: 'InvalidConfig',
            message: 'Unexpected token at line 4',
          }}
          stale={false}
          onOpenRawConfig={onOpenRawConfig}
          onReloadFromDisk={onReloadFromDisk}
        />
      </I18nProvider>,
    );
    const errorAlert = view.getByRole('alert');
    expect(errorAlert.textContent).toContain(
      t('banners.configUnavailable', { message: 'Unexpected token at line 4' }),
    );
    fireEvent.click(view.getByRole('button', { name: t('raw.title') }));
    expect(onOpenRawConfig).toHaveBeenCalledTimes(1);

    // KeySetupFailed uses its exact message without banners.configUnavailable wrapper.
    view.rerender(
      <I18nProvider>
        <ConfigBlockerBar
          configError={{
            occurrenceId: 'occ-2',
            code: 'KeySetupFailed',
            message: 'Unlock macOS Keychain to create the gateway key.',
          }}
          stale={false}
          disabled={true}
          onOpenRawConfig={onOpenRawConfig}
          onReloadFromDisk={onReloadFromDisk}
        />
      </I18nProvider>,
    );
    expect(view.getByRole('alert').textContent).toContain(
      'Unlock macOS Keychain to create the gateway key.',
    );
    expect((view.getByRole('button', { name: t('raw.title') }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // Stale draft without configError triggers reload from disk.
    view.rerender(
      <I18nProvider>
        <ConfigBlockerBar
          configError={null}
          stale={true}
          onOpenRawConfig={onOpenRawConfig}
          onReloadFromDisk={onReloadFromDisk}
        />
      </I18nProvider>,
    );
    expect(view.getByRole('alert').textContent).toContain(t('banners.stale'));
    fireEvent.click(view.getByRole('button', { name: t('raw.reset') }));
    expect(onReloadFromDisk).toHaveBeenCalledTimes(1);
  });

  test('GatewayToggle reflects running/stopped status, blocks dirty/broken configs, and calls start/stop', async () => {
    let startCalls = 0;
    let stopCalls = 0;
    const mockBundle = createMockAppClient(makeSnapshot(), {
      start: async () => {
        startCalls += 1;
        return { ok: true, value: makeSnapshot({ gateway: { running: true } }) };
      },
      stop: async () => {
        stopCalls += 1;
        return { ok: true, value: makeSnapshot({ gateway: { running: false } }) };
      },
    });
    const run = mock(async (op: () => Promise<AppResult<AppSnapshot | null>>) => (await op()).ok);

    const view = renderWithI18n(
      <GatewayToggle
        gateway={makeGatewaySnapshot({ running: false })}
        dirty={false}
        configurationLocked={false}
        run={run}
        client={mockBundle.client}
      />,
    );

    expect(view.getByRole('status').textContent).toBe(t('common.gatewayStopped'));
    const startButton = view.getByRole('button', {
      name: t('common.startGateway'),
    }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(startButton);
    });
    expect(startCalls).toBe(1);

    // Running state triggers stop().
    view.rerender(
      <I18nProvider>
        <GatewayToggle
          gateway={makeGatewaySnapshot({ running: true })}
          dirty={true}
          configurationLocked={false}
          run={run}
          client={mockBundle.client}
        />
      </I18nProvider>,
    );
    expect(view.getByRole('status').textContent).toBe(t('common.gatewayRunning'));
    const stopButton = view.getByRole('button', {
      name: t('common.stopGateway'),
    }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(stopButton);
    });
    expect(stopCalls).toBe(1);

    // Stopped + dirty disables button with save-first title on wrapper.
    view.rerender(
      <I18nProvider>
        <GatewayToggle
          gateway={makeGatewaySnapshot({ running: false })}
          dirty={true}
          configurationLocked={false}
          run={run}
          client={mockBundle.client}
        />
      </I18nProvider>,
    );
    const dirtyBtn = view.getByRole('button', {
      name: t('common.startGateway'),
    }) as HTMLButtonElement;
    expect(dirtyBtn.disabled).toBe(true);
    expect(dirtyBtn.parentElement?.getAttribute('title')).toBe(t('toggle.saveFirst'));

    // Stopped + InvalidConfig disables button with repair-first title.
    view.rerender(
      <I18nProvider>
        <GatewayToggle
          gateway={makeGatewaySnapshot({
            running: false,
            configError: { occurrenceId: 'err-1', code: 'InvalidConfig', message: 'Bad config' },
          })}
          dirty={false}
          configurationLocked={false}
          run={run}
          client={mockBundle.client}
        />
      </I18nProvider>,
    );
    const brokenBtn = view.getByRole('button', {
      name: t('common.startGateway'),
    }) as HTMLButtonElement;
    expect(brokenBtn.disabled).toBe(true);
    expect(brokenBtn.parentElement?.getAttribute('title')).toBe(t('toggle.repairFirst'));

    // Stopped + KeyUnavailable stays enabled so Start can retry reading Keychain.
    view.rerender(
      <I18nProvider>
        <GatewayToggle
          gateway={makeGatewaySnapshot({
            running: false,
            configError: { occurrenceId: 'err-2', code: 'KeyUnavailable', message: 'Locked' },
          })}
          dirty={false}
          configurationLocked={false}
          run={run}
          client={mockBundle.client}
        />
      </I18nProvider>,
    );
    expect(
      (view.getByRole('button', { name: t('common.startGateway') }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test('SidebarUpdates hides when unsupported, shows available badge, and routes ready to 1-click restart', () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onOpen = mock(() => {});
    const onRestart = mock(() => {});

    const view = renderWithI18n(
      <SidebarUpdates
        updateState={makeUpdateStatus({ supported: false })}
        disabled={false}
        onOpen={onOpen}
        onRestart={onRestart}
        triggerRef={triggerRef}
      />,
    );
    expect(view.queryByRole('button')).toBeNull();

    // Available phase shows version detail and opens modal.
    view.rerender(
      <I18nProvider>
        <SidebarUpdates
          updateState={makeUpdateStatus({
            supported: true,
            phase: 'available',
            availableVersion: '0.10.0',
          })}
          disabled={false}
          onOpen={onOpen}
          onRestart={onRestart}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    );
    const availableBtn = view.getByRole('button') as HTMLButtonElement;
    expect(availableBtn.getAttribute('data-phase')).toBe('available');
    expect(availableBtn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(availableBtn.textContent).toContain(t('sidebarUpdates.available'));
    expect(availableBtn.textContent).toContain('0.10.0');
    fireEvent.click(availableBtn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(0);

    // Ready phase triggers 1-click restart when onRestart is supplied.
    view.rerender(
      <I18nProvider>
        <SidebarUpdates
          updateState={makeUpdateStatus({
            supported: true,
            phase: 'ready',
            availableVersion: '0.10.0',
          })}
          disabled={false}
          onOpen={onOpen}
          onRestart={onRestart}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    );
    const readyBtn = view.getByRole('button') as HTMLButtonElement;
    expect(readyBtn.getAttribute('data-phase')).toBe('ready');
    expect(readyBtn.getAttribute('aria-haspopup')).toBeNull();
    expect(readyBtn.textContent).toContain(t('sidebarUpdates.ready'));
    expect(readyBtn.textContent).toContain(t('sidebarUpdates.restartToInstall'));
    fireEvent.click(readyBtn);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Restarting phase disables the button.
    view.rerender(
      <I18nProvider>
        <SidebarUpdates
          updateState={makeUpdateStatus({
            supported: true,
            phase: 'restarting',
            availableVersion: '0.10.0',
          })}
          disabled={false}
          onOpen={onOpen}
          onRestart={onRestart}
          triggerRef={triggerRef}
        />
      </I18nProvider>,
    );
    expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Dialogs (KeyMigration, WhatsNew, ServerEditor)', () => {
  test('KeyMigration renders masked secret badges (SEC-04), freezes reviewed slots, and handles move/failure/keep/dirty', async () => {
    const fallbackFocus = createRef<HTMLButtonElement>();
    const onKeep = mock(() => {});
    const onClose = mock(() => {});
    const movedSlots: KeyMigrationSlots[] = [];
    let moveShouldSucceed = true;
    const onMove = mock(async (slots: KeyMigrationSlots) => {
      movedSlots.push(slots);
      return moveShouldSucceed;
    });

    const initialSlots: KeyMigrationSlots = { gateway: true, servers: ['bear', 'linear'] };
    const view = renderWithI18n(
      <KeyMigration
        slots={initialSlots}
        dirty={false}
        busy={false}
        error={null}
        filename="mcp.json"
        fallbackFocus={fallbackFocus}
        onKeep={onKeep}
        onClose={onClose}
        onMove={onMove}
      />,
    );

    const dialog = view.getByRole('dialog', { name: t('keys.title') });
    const maskedBadges = dialog.querySelectorAll('code.masked-secret');
    expect(maskedBadges).toHaveLength(3);
    for (const badge of maskedBadges) {
      expect(badge.textContent).toBe('••••••••');
    }
    expect(dialog.textContent).toContain(t('keys.global'));
    expect(dialog.textContent).toContain(t('keys.server', { name: 'bear' }));
    expect(dialog.textContent).toContain(t('keys.server', { name: 'linear' }));

    // Keep in file triggers onKeep.
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.keep') }));
    expect(onKeep).toHaveBeenCalledTimes(1);

    // Step 1 -> Step 2 freezes reviewed slots even if live slots change underneath.
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.continue') }));
    expect(dialog.textContent).toContain(t('keys.step2'));

    view.rerender(
      <I18nProvider>
        <KeyMigration
          slots={{ gateway: true, servers: ['bear', 'linear', 'extra'] }}
          dirty={false}
          busy={false}
          error="Keychain locked"
          filename="mcp.json"
          fallbackFocus={fallbackFocus}
          onKeep={onKeep}
          onClose={onClose}
          onMove={onMove}
        />
      </I18nProvider>,
    );

    // Failed move transitions to failed state and displays sanitized error.
    moveShouldSucceed = false;
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: t('keys.moveMany', { count: 3 }) }),
      );
    });
    expect(movedSlots[0]).toEqual(initialSlots);
    expect(within(dialog).getByRole('alert').textContent).toBe(t('keys.failed'));
    expect(dialog.textContent).toContain('Keychain locked');

    // Try again returns to review step (now showing updated 4 slots).
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.tryAgain') }));
    expect(dialog.querySelectorAll('code.masked-secret')).toHaveLength(4);

    // Successful move transitions to done and closes on Done.
    moveShouldSucceed = true;
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.continue') }));
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: t('keys.moveMany', { count: 4 }) }),
      );
    });
    expect(within(dialog).getByRole('status').textContent).toBe(t('keys.moved'));
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.done') }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Dirty state blocks migration steps until config is saved.
    cleanupDom();
    const dirtyView = renderWithI18n(
      <KeyMigration
        slots={initialSlots}
        dirty={true}
        busy={false}
        error={null}
        filename="mcp.json"
        fallbackFocus={fallbackFocus}
        onKeep={onKeep}
        onClose={onClose}
        onMove={onMove}
      />,
    );
    expect(dirtyView.getByText(t('keys.saveFirst'))).toBeTruthy();
    expect(dirtyView.queryByRole('button', { name: t('keys.continue') })).toBeNull();
  });

  test('WhatsNew renders release note blocks for a valid version, hides unknown versions, and calls onClose', () => {
    const fallbackFocus = createRef<HTMLButtonElement>();
    const onClose = mock(() => {});

    const missing = renderWithI18n(
      <WhatsNew version="99.99.99" onClose={onClose} fallbackFocus={fallbackFocus} />,
    );
    expect(missing.queryByRole('dialog')).toBeNull();
    cleanupDom();

    const view = renderWithI18n(
      <WhatsNew version="0.9.0" onClose={onClose} fallbackFocus={fallbackFocus} />,
    );

    const dialog = view.getByRole('dialog', { name: t('whatsNew.title', { version: '0.9.0' }) });
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Added' })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Fixed' })).toBeTruthy();
    expect(dialog.querySelectorAll('ul li').length).toBeGreaterThan(0);
    // Inline markdown formatting: bold and code spans render as <strong> and <code>.
    expect(dialog.querySelectorAll('strong').length).toBeGreaterThan(0);
    expect(dialog.querySelectorAll('code').length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole('button', { name: t('whatsNew.done') }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('ServerEditor renders stdio/http structured rows, sensitiveEnvOverrides warning (SEC-03), Bear preset, validation, and submits', () => {
    const fallbackFocus = createRef<HTMLButtonElement>();
    const submitted: Editor[] = [];
    const onClose = mock(() => {});

    const view = renderWithI18n(
      <StatefulServerEditor
        initial={emptyEditor()}
        existingNames={new Set(['existing'])}
        fallbackFocus={fallbackFocus}
        onClose={onClose}
        onSubmitted={(value) => submitted.push(value)}
      />,
    );
    const dialog = view.getByRole('dialog', { name: t('editor.addTitle') });

    // Apply Bear preset without a typed name -> fills 'bear', command, and ['mcp-server'].
    fireEvent.click(within(dialog).getByRole('button', { name: t('editor.bearPreset') }));
    expect((within(dialog).getByLabelText(t('editor.name')) as HTMLInputElement).value).toBe(
      'bear',
    );
    expect((within(dialog).getByLabelText(t('editor.command')) as HTMLInputElement).value).toBe(
      '/Applications/Bear.app/Contents/MacOS/bearcli',
    );
    expect((within(dialog).getByPlaceholderText('--arg-1') as HTMLInputElement).value).toBe(
      'mcp-server',
    );

    // Add a second arg and then remove it.
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Argument/i }));
    const arg2 = within(dialog).getByPlaceholderText('--arg-2') as HTMLInputElement;
    setInputValue(arg2, '--verbose');
    expect(arg2.value).toBe('--verbose');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove argument 2' }));
    expect(within(dialog).queryByPlaceholderText('--arg-2')).toBeNull();

    // Add an env row overriding sensitive PATH -> amber warning Alert appears (SEC-03).
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Row/i }));
    const keyInput = within(dialog).getByPlaceholderText('KEY') as HTMLInputElement;
    const valueInput = within(dialog).getByPlaceholderText(
      `value or \${ENV_VAR}`,
    ) as HTMLInputElement;
    setInputValue(keyInput, 'PATH');
    setInputValue(valueInput, '/custom/bin');

    const warningBanner = within(dialog).getByRole('alert');
    expect(warningBanner.textContent).toContain(
      'Overrides sensitive execution environment variable(s): PATH',
    );
    expect(warningBanner.className).toContain('bg-mac-yellow/12');

    // Mask/show toggle flips value input type between text and password.
    expect(valueInput.type).toBe('text');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mask value' }));
    expect(valueInput.type).toBe('password');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show value' }));
    expect(valueInput.type).toBe('text');

    // Dismissing the warning hides it for the same key signature, then adding HOME re-triggers it.
    fireEvent.click(within(warningBanner).getByRole('button', { name: t('common.dismissError') }));
    expect(within(dialog).queryByText(/Overrides sensitive execution environment/i)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: /Add Row/i }));
    const keyInputs = within(dialog).getAllByPlaceholderText('KEY') as HTMLInputElement[];
    setInputValue(must(keyInputs[1]), 'HOME');
    expect(within(dialog).getByRole('alert').textContent).toContain('PATH, HOME');

    // Duplicate server name shows inline alert and disables Apply.
    const nameInput = within(dialog).getByLabelText(t('editor.name')) as HTMLInputElement;
    const applyBtn = within(dialog).getByRole('button', {
      name: t('editor.apply'),
    }) as HTMLButtonElement;
    setInputValue(nameInput, 'existing');
    expect(within(dialog).getByText(t('app.serverExists'))).toBeTruthy();
    expect(applyBtn.disabled).toBe(true);

    // Fix name back to unique name and submit stdio configuration.
    setInputValue(nameInput, 'bear_notes');
    expect(applyBtn.disabled).toBe(false);
    fireEvent.click(applyBtn);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.name).toBe('bear_notes');
    expect(submitted[0]?.type).toBe('stdio');
    expect(submitted[0]?.command).toBe('/Applications/Bear.app/Contents/MacOS/bearcli');
    expect(submitted[0]?.args).toEqual(['mcp-server']);

    // Switch transport to HTTP and edit URL + structured headers + custom auth key.
    const transportSelect = within(dialog).getByLabelText(
      t('editor.transport'),
    ) as HTMLSelectElement;
    fireEvent.change(transportSelect, { target: { value: 'http' } });
    const urlInput = within(dialog).getByLabelText(t('editor.url')) as HTMLInputElement;
    setInputValue(urlInput, 'https://mcp.example.com/sse');

    fireEvent.click(within(dialog).getByRole('button', { name: /Add Row/i }));
    setInputValue(within(dialog).getByPlaceholderText('KEY') as HTMLInputElement, 'Authorization');
    setInputValue(
      within(dialog).getByPlaceholderText(`value or \${ENV_VAR}`) as HTMLInputElement,
      `Bearer \${API_TOKEN}`,
    );

    const authSelect = within(dialog).getByLabelText(t('editor.auth')) as HTMLSelectElement;
    fireEvent.change(authSelect, { target: { value: 'custom' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('editor.generateKey') }));
    const keyField = within(dialog).getByLabelText(t('editor.key')) as HTMLInputElement;
    expect(keyField.type).toBe('password');
    expect(keyField.value).toMatch(/^[0-9a-f]{64}$/);
    fireEvent.click(within(dialog).getByRole('button', { name: t('editor.showKey') }));
    expect(keyField.type).toBe('text');

    fireEvent.click(applyBtn);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.type).toBe('http');
    expect(submitted[1]?.url).toBe('https://mcp.example.com/sse');
    expect(submitted[1]?.headers).toHaveLength(1);
    expect(submitted[1]?.headers[0]).toMatchObject({
      key: 'Authorization',
      value: `Bearer \${API_TOKEN}`,
    });
    expect(submitted[1]?.token).toMatch(/^[0-9a-f]{64}$/);

    // Invalid headers (duplicate key) disables submit and shows error.
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Row/i }));
    const headerKeys = within(dialog).getAllByPlaceholderText('KEY') as HTMLInputElement[];
    setInputValue(must(headerKeys[1]), 'Authorization');
    expect(within(dialog).getByText(t('app.headersInvalid'))).toBeTruthy();
    expect(applyBtn.disabled).toBe(true);
  });

  test('ServerEditor renders secret masking by default for pre-populated API keys and shows Keychain stored state for tokenRef', () => {
    const fallbackFocus = createRef<HTMLButtonElement>();
    const editor: Editor = {
      ...emptyEditor(),
      original: 'remote',
      name: 'remote',
      type: 'http',
      url: 'https://api.example.com/mcp',
      headers: [createKeyValueRow('X-API-Key', 'super-secret-value')],
      tokenRef: 'keychain-server-1',
    };

    const view = renderWithI18n(
      <ServerEditor
        editor={editor}
        editorError={null}
        configurationLocked={false}
        fallbackFocus={fallbackFocus}
        onChange={() => {}}
        onClose={() => {}}
        onSubmit={(event) => event.preventDefault()}
        onDismissError={() => {}}
      />,
    );

    const dialog = view.getByRole('dialog', { name: t('common.editServer') });
    const valueInput = within(dialog).getByDisplayValue('super-secret-value') as HTMLInputElement;
    expect(valueInput.type).toBe('password');
    expect(dialog.textContent).toContain(t('keys.stored'));
  });
});

describe('Views: Overview, Settings, Updates, Logs', () => {
  test('Overview renders empty-state Bear preset CTA and opens ServerEditor when clicked', async () => {
    const mockBundle = createMockAppClient(
      makeSnapshot({ gateway: { configText: makeConfigText() } }),
    );

    const view = renderWithI18n(<App client={mockBundle.client} />);

    await waitFor(() => {
      expect(view.getByText(t('overview.emptyTitle'))).toBeTruthy();
    });

    fireEvent.click(view.getByRole('button', { name: t('overview.bearPreset') }));
    const dialog = view.getByRole('dialog', { name: t('editor.addTitle') });
    expect((within(dialog).getByLabelText(t('editor.name')) as HTMLInputElement).value).toBe(
      'bear',
    );
    expect((within(dialog).getByLabelText(t('editor.command')) as HTMLInputElement).value).toBe(
      '/Applications/Bear.app/Contents/MacOS/bearcli',
    );
  });

  test('Overview renders server rows, health status badges, and triggers Add, Edit, Test, Restart, Toggle, and Delete', async () => {
    const configText = makeConfigText({
      bear: { command: '/Applications/Bear.app/Contents/MacOS/bearcli', args: ['mcp-server'] },
      remote: { url: 'https://mcp.example.com/sse' },
    });
    const mockBundle = createMockAppClient(
      makeSnapshot({
        keyReminder: true,
        gateway: {
          running: true,
          configText,
          keyMigration: { gateway: true, servers: [] },
          servers: [
            {
              name: 'bear',
              type: 'stdio',
              endpoint: '/mcp/bear',
              enabled: true,
              status: 'mounted',
              error: null,
            },
            {
              name: 'remote',
              type: 'http',
              endpoint: '/mcp/remote',
              enabled: true,
              status: 'error',
              error: { occurrenceId: 'srv-err-1', code: 'BackendFailure', message: 'HTTP 502' },
            },
          ],
        },
      }),
    );

    const view = renderWithI18n(<App client={mockBundle.client} />);

    await waitFor(() => {
      expect(view.getByText('bear')).toBeTruthy();
    });

    const rows = view.container.querySelectorAll('article.server-row');
    expect(rows).toHaveLength(2);
    const bearRow = rows[0] as HTMLElement;
    const remoteRow = rows[1] as HTMLElement;

    // Health badges, transport labels, endpoints, and live errors.
    expect(bearRow.querySelector('.led')?.getAttribute('title')).toBe(t('overview.status.mounted'));
    expect(bearRow.textContent).toContain('STDIO');
    expect(bearRow.textContent).toContain('/mcp/bear');

    expect(remoteRow.className).toContain('error');
    expect(remoteRow.querySelector('.led')?.getAttribute('title')).toBe(t('overview.status.error'));
    expect(remoteRow.textContent).toContain('HTTP');
    expect(remoteRow.textContent).toContain('HTTP 502');

    // Test connection triggers client.testServer and shows passed message.
    await act(async () => {
      fireEvent.click(
        within(bearRow).getByRole('button', {
          name: t('overview.testConnectionFor', { name: 'bear' }),
        }),
      );
    });
    expect(mockBundle.calls.testServer).toEqual([{ name: 'bear', expectedRevision: 'rev-1' }]);
    expect(bearRow.textContent).toContain(t('overview.testPassed', { version: '2025-11-25' }));

    // Restart button triggers client.restartServer.
    await act(async () => {
      fireEvent.click(
        within(bearRow).getByRole('button', { name: t('overview.restart', { name: 'bear' }) }),
      );
    });
    expect(mockBundle.calls.restartServer).toEqual([{ name: 'bear' }]);

    // Edit button opens ServerEditor for that server, and Add Server opens a blank ServerEditor.
    fireEvent.click(within(bearRow).getByRole('button', { name: t('common.editServer') }));
    const editDialog = view.getByRole('dialog', { name: t('common.editServer') });
    expect((within(editDialog).getByLabelText(t('editor.name')) as HTMLInputElement).value).toBe(
      'bear',
    );
    fireEvent.click(within(editDialog).getByRole('button', { name: t('common.cancel') }));
    expect(view.queryByRole('dialog')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: t('overview.addServer') }));
    expect(view.getByRole('dialog', { name: t('editor.addTitle') })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: t('common.cancel') }));

    // Key reminder banner opens KeyMigration on Review, or dismisses via dismissKeyReminder.
    expect(view.getByText(t('keys.reminder'))).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: t('keys.dismiss') }));
    await waitFor(() => {
      expect(mockBundle.calls.dismissKeyReminder).toBe(1);
    });

    // Delete button confirms via confirmDeleteServer and saves updated config.
    await act(async () => {
      fireEvent.click(
        within(remoteRow).getByRole('button', { name: t('overview.delete', { name: 'remote' }) }),
      );
    });
    expect(mockBundle.calls.confirmDeleteServer).toEqual([{ name: 'remote' }]);
    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    const saved = lastSavedConfig(mockBundle);
    expect(saved.mcpServers.remote).toBeUndefined();
    expect(saved.mcpServers.bear).toBeDefined();
  });

  test('Overview renders repair state when config is invalid and commits server toggle switches', async () => {
    const brokenBundle = createMockAppClient(
      makeSnapshot({
        gateway: {
          configText: '{ broken',
          configError: {
            occurrenceId: 'cfg-broken-1',
            code: 'InvalidConfig',
            message: 'Unexpected EOF',
          },
        },
      }),
    );
    const brokenView = renderWithGateway(brokenBundle.client, <Overview />);
    await waitFor(() => {
      expect(brokenView.getByText(t('overview.repairTitle'))).toBeTruthy();
    });
    expect(brokenView.getByText(t('overview.repairBody'))).toBeTruthy();
    cleanupDom();

    const toggleBundle = createMockAppClient(
      makeSnapshot({
        gateway: {
          running: true,
          configText: makeConfigText({
            bear: { command: '/usr/bin/env', args: ['bear'], disabled: false },
          }),
          servers: [
            {
              name: 'bear',
              type: 'stdio',
              endpoint: '/mcp/bear',
              enabled: true,
              status: 'mounted',
              error: null,
            },
          ],
        },
      }),
    );
    const toggleView = renderWithGateway(toggleBundle.client, <Overview />);
    await waitFor(() => {
      expect(toggleView.getByText('bear')).toBeTruthy();
    });

    const serverSwitch = toggleView.getByRole('switch');
    await act(async () => {
      fireEvent.click(serverSwitch);
    });
    expect(toggleBundle.calls.saveConfig).toHaveLength(1);
    expect(lastSavedConfig(toggleBundle).mcpServers.bear?.disabled).toBe(true);
  });

  test('Settings renders host, port, allowedPeers (Plan 033), auth token, keepAwake (Plan 028), launchAtLogin, language, and advanced actions', async () => {
    const mockBundle = createMockAppClient(
      makeSnapshot({
        gateway: {
          configText: makeConfigText(
            {},
            {
              host: '127.0.0.1',
              port: 8787,
              token: 'b'.repeat(64),
              keepAwake: false,
              launchAtLogin: false,
              allowedPeers: ['192.168.1.0/24'],
            },
          ),
          keyMigration: { gateway: true, servers: [] },
        },
      }),
    );

    const view = renderWithGateway(mockBundle.client, <Settings />);

    await waitFor(() => {
      expect(view.getByText(t('settings.preferences'))).toBeTruthy();
    });

    // Host input + interfaces datalist.
    const hostInput = view.getByLabelText(t('settings.address')) as HTMLInputElement;
    expect(hostInput.value).toBe('127.0.0.1');
    expect(view.container.querySelectorAll('#interfaces option')).toHaveLength(2);
    setInputValue(hostInput, '192.168.1.25');
    await act(async () => {
      fireEvent.blur(hostInput);
    });
    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    expect(lastSavedConfig(mockBundle).gateway.host).toBe('192.168.1.25');

    // Port input commits on Enter.
    const portInput = view.getByLabelText(t('settings.port')) as HTMLInputElement;
    expect(portInput.value).toBe('8787');
    setInputValue(portInput, '9090');
    await act(async () => {
      fireEvent.keyDown(portInput, { key: 'Enter' });
    });
    expect(lastSavedConfig(mockBundle).gateway.port).toBe(9090);

    // Plan 033: separator-only allowedPeers (", ,") stays an empty array [] instead of undefined.
    const peersInput = view.getByLabelText(t('settings.peers')) as HTMLInputElement;
    expect(peersInput.value).toBe('192.168.1.0/24');
    setInputValue(peersInput, ', ,');
    await act(async () => {
      fireEvent.blur(peersInput);
    });
    expect(lastSavedConfig(mockBundle).gateway.allowedPeers).toEqual([]);

    // Blank allowedPeers removes the property (undefined).
    setInputValue(peersInput, '   ');
    await act(async () => {
      fireEvent.blur(peersInput);
    });
    expect(lastSavedConfig(mockBundle).gateway.allowedPeers).toBeUndefined();

    // Auth token show/hide toggle and Generate button.
    const tokenInput = view.getByLabelText(t('settings.token')) as HTMLInputElement;
    expect(tokenInput.type).toBe('password');
    fireEvent.click(view.getByRole('button', { name: t('settings.showToken') }));
    expect(tokenInput.type).toBe('text');

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: t('settings.generateToken') }));
    });
    const generated = lastSavedConfig(mockBundle).gateway.token;
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(generated).not.toBe('b'.repeat(64));

    // Plan 028: keepAwake toggle commits true, then omits property when toggled off.
    const keepAwakeSwitch = getToggleControl(view.container, t('settings.keepAwake'));
    await act(async () => {
      fireEvent.click(keepAwakeSwitch);
    });
    expect(lastSavedConfig(mockBundle).gateway.keepAwake).toBe(true);
    await act(async () => {
      fireEvent.click(keepAwakeSwitch);
    });
    expect(lastSavedConfig(mockBundle).gateway.keepAwake).toBeUndefined();

    // launchAtLogin toggle commits true.
    const loginSwitch = getToggleControl(view.container, t('settings.launchAtLogin'));
    await act(async () => {
      fireEvent.click(loginSwitch);
    });
    expect(lastSavedConfig(mockBundle).gateway.launchAtLogin).toBe(true);

    // Advanced buttons trigger revealConfig, openConfigInEditor, and importExternalServers.
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: t('raw.showInFinder') }));
      fireEvent.click(view.getByRole('button', { name: 'Open in External Editor' }));
      fireEvent.click(
        view.getByRole('button', { name: 'Import Servers from Claude Desktop / Cursor' }),
      );
    });
    expect(mockBundle.calls.revealConfig).toBe(1);
    expect(mockBundle.calls.openConfigInEditor).toBe(1);
    expect(mockBundle.calls.importExternalServers).toHaveLength(1);
    expect(view.getByRole('status').textContent).toContain(
      'Imported 2 servers from Claude Desktop / Cursor.',
    );

    // Language selector invokes client.setLanguage and updates localized headings.
    const languageSelect = view.getByLabelText(t('shell.languageLabel')) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(languageSelect, { target: { value: 'fr_FR' } });
    });
    expect(mockBundle.calls.setLanguage).toEqual([{ preference: 'fr_FR' }]);
    await waitFor(() => {
      expect(view.getByText(translator('fr_FR')('settings.preferences'))).toBeTruthy();
    });
  });

  test('Updates renders version, auto-check toggle, Check button, 1-click Install & Relaunch (D-02), and determinate progress bar (D-17)', async () => {
    const mockBundle = createMockAppClient(
      makeSnapshot({
        update: {
          supported: true,
          automaticUpdates: true,
          installedVersion: '0.9.0',
          availableVersion: '0.10.0',
          phase: 'available',
          checkedAt: '2026-11-27T08:00:00.000Z',
        },
      }),
    );

    const view = renderWithGateway(mockBundle.client, <Updates />);

    await waitFor(() => {
      expect(view.getByText('0.9.0')).toBeTruthy();
    });
    expect(view.getByText('0.10.0')).toBeTruthy();
    expect(view.getByRole('status').textContent).toBe(
      t('updates.status.availableVersion', { version: '0.10.0' }),
    );

    // Toggle automatic update checks.
    const autoSwitch = getToggleControl(view.container, t('updates.automatic'));
    await act(async () => {
      fireEvent.click(autoSwitch);
    });
    expect(mockBundle.calls.updatesSetAutomatic).toEqual([{ automatic: false }]);

    // Check for Updates button invokes client.updatesCheck().
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: t('updates.check') }));
    });
    expect(mockBundle.calls.updatesCheck).toBe(1);

    // 1-click Install and Relaunch while available calls updatesInstall().
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Install and Relaunch' }));
    });
    expect(mockBundle.calls.updatesInstall).toBe(1);

    // Downloading phase with percentage and byte counts renders determinate progressbar (D-17).
    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          update: {
            supported: true,
            automaticUpdates: true,
            installedVersion: '0.9.0',
            availableVersion: '0.10.0',
            phase: 'downloading',
            progressPercent: 45,
            downloadedBytes: 4.5 * 1024 * 1024,
            totalBytes: 10 * 1024 * 1024,
          },
        }),
      );
    });

    const progressbar = view.getByRole('progressbar', { name: t('updates.progress') });
    expect(progressbar.getAttribute('aria-valuenow')).toBe('45');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('45% · 4.5 MB / 10.0 MB');
    expect((progressbar.firstElementChild as HTMLElement).style.width).toBe('45%');
    expect(view.getByText('45% · 4.5 MB / 10.0 MB')).toBeTruthy();

    // Ready phase: clicking Install and Relaunch invokes requestUpdateRestart -> client.updatesRestart().
    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          update: {
            supported: true,
            automaticUpdates: true,
            installedVersion: '0.9.0',
            availableVersion: '0.10.0',
            phase: 'ready',
          },
        }),
      );
    });
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Install and Relaunch' }));
    });
    expect(mockBundle.calls.updatesRestart).toBe(1);
  });

  test('Logs renders Console rows, filters by search, level, and server, clears logs, and auto-retries after readLogs failure (Plan 034)', async () => {
    const entries: LogEntry[] = [
      {
        id: 1,
        time: '12:00:01',
        server: 'bear',
        level: 'info',
        source: 'controller',
        text: 'Mounted bear stdio backend',
        truncated: false,
      },
      {
        id: 2,
        time: '12:00:02',
        server: 'remote',
        level: 'error',
        source: 'stderr',
        text: 'Connection timeout talking to remote',
        truncated: true,
      },
      {
        id: 3,
        time: '12:00:03',
        server: null,
        level: 'warn',
        source: 'logger',
        text: 'Gateway listener retrying bind',
        truncated: false,
      },
    ];

    let readCalls = 0;
    let clearCalls = 0;
    const scheduledPoll: { current: (() => void) | null } = { current: null };
    const realSetTimeout = globalThis.setTimeout;

    const mockBundle = createMockAppClient(makeSnapshot(), {
      readLogs: async (): Promise<AppResult<LogPage>> => {
        readCalls += 1;
        if (readCalls === 1) {
          return {
            ok: false,
            error: { code: 'LogIO', message: 'Log buffer temporarily busy' },
          };
        }
        if (readCalls === 2) {
          return {
            ok: true,
            value: { entries, cursor: 3, generation: 1, gap: false, hasMore: false },
          };
        }
        return {
          ok: true,
          value: { entries: [], cursor: 3, generation: 1, gap: false, hasMore: false },
        };
      },
      clearLogs: async (): Promise<AppResult<LogPage>> => {
        clearCalls += 1;
        return {
          ok: true,
          value: { entries: [], cursor: 0, generation: 2, gap: false, hasMore: false },
        };
      },
    });

    // Capture the 2000ms polling timer so Plan 034 retry is verified deterministically without sleeping.
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 2000 && typeof handler === 'function') {
        scheduledPoll.current = () => handler(...args);
        return 99999 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;

    try {
      const view = renderWithI18n(<Logs client={mockBundle.client} servers={['bear', 'remote']} />);

      // Plan 034: initial readLogs failure displays the alert AND schedules a retry poll.
      await waitFor(() => {
        expect(view.getByRole('alert').textContent).toContain('LogIO: Log buffer temporarily busy');
      });
      expect(readCalls).toBe(1);
      expect(scheduledPoll.current).not.toBeNull();

      // Trigger the scheduled retry poll -> succeeds, clears the error alert, and renders rows.
      const runRetry = must(scheduledPoll.current, 'scheduled poll');
      scheduledPoll.current = null;
      await act(async () => {
        runRetry();
      });

      await waitFor(() => {
        expect(view.queryByRole('alert')).toBeNull();
        expect(view.container.querySelectorAll('.log-row')).toHaveLength(3);
      });
      expect(view.getByText('Mounted bear stdio backend')).toBeTruthy();
      expect(
        view.getByText(`Connection timeout talking to remote (${t('logs.truncated')})`),
      ).toBeTruthy();
      expect(view.getByText(t('logs.appSource'))).toBeTruthy();

      // Filter by level.
      const levelSelect = view.getByLabelText(t('logs.level')) as HTMLSelectElement;
      fireEvent.change(levelSelect, { target: { value: 'error' } });
      expect(view.container.querySelectorAll('.log-row')).toHaveLength(1);
      expect(view.getByText(/Connection timeout/)).toBeTruthy();
      fireEvent.change(levelSelect, { target: { value: '' } });

      // Filter by server.
      const serverSelect = view.getByLabelText(t('logs.server')) as HTMLSelectElement;
      fireEvent.change(serverSelect, { target: { value: 'bear' } });
      expect(view.container.querySelectorAll('.log-row')).toHaveLength(1);
      expect(view.getByText('Mounted bear stdio backend')).toBeTruthy();
      fireEvent.change(serverSelect, { target: { value: '' } });

      // Filter by search text (case-insensitive) and verify no-matches state.
      const searchInput = view.getByLabelText(t('logs.search')) as HTMLInputElement;
      setInputValue(searchInput, 'LISTENER');
      expect(view.container.querySelectorAll('.log-row')).toHaveLength(1);
      expect(view.getByText('Gateway listener retrying bind')).toBeTruthy();

      setInputValue(searchInput, 'does-not-exist');
      expect(view.getByText(t('logs.noMatches'))).toBeTruthy();
      setInputValue(searchInput, '');

      // Clear logs invokes client.clearLogs() and resets to empty state.
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: t('logs.clear') }));
      });
      expect(clearCalls).toBe(1);
      await waitFor(() => {
        expect(view.getByText(t('logs.empty'))).toBeTruthy();
      });

      view.unmount();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('App shell and modal arbitration (src/mainview/App.tsx)', () => {
  test('renders connecting state while snapshot loads, switches Overview/Settings/Logs tabs, and opens RawConfig from ConfigBlockerBar', async () => {
    const pendingSnapshot = deferred<AppResult<AppSnapshot>>();
    const mockBundle = createMockAppClient(makeSnapshot(), {
      snapshot: () => pendingSnapshot.promise,
    });

    const view = renderWithI18n(<App client={mockBundle.client} />);

    // Loading state before initial snapshot arrives.
    expect(view.getByText(t('app.connecting'))).toBeTruthy();
    expect(view.getByText(t('shell.network.loading'))).toBeTruthy();

    // Hydrate with a configError so ConfigBlockerBar is shown on Overview.
    await act(async () => {
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
    });

    await waitFor(() => {
      expect(view.getByRole('heading', { level: 1, name: t('shell.title.overview') })).toBeTruthy();
    });
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('overview');
    expect(view.getByRole('alert').textContent).toContain('Malformed JSON');

    // Clicking Raw Configuration on ConfigBlockerBar switches to Settings and expands RawConfig.
    fireEvent.click(view.getByRole('button', { name: t('raw.title') }));
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('settings');
    expect(view.getByRole('heading', { level: 1, name: t('shell.title.settings') })).toBeTruthy();
    const rawHeadingBtn = view.container.querySelector('button.raw-heading');
    expect(rawHeadingBtn?.getAttribute('aria-expanded')).toBe('true');

    // Navigate via sidebar buttons to Logs and back to Overview.
    const nav = view.getByRole('navigation', { name: t('shell.mainNavigation') });
    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.logs') }));
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('logs');
    expect(view.getByRole('heading', { level: 1, name: t('shell.title.logs') })).toBeTruthy();

    fireEvent.click(within(nav).getByRole('button', { name: t('shell.tab.overview') }));
    expect(view.container.querySelector('main')?.getAttribute('data-tab')).toBe('overview');
  });

  test('arbitrates single active modal across WhatsNew, ServerEditor, KeyMigration, and Updates', async () => {
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

    const view = renderWithI18n(<App client={mockBundle.client} />);

    // 1. WhatsNew opens automatically while no other modal is active, and disables SidebarUpdates.
    await waitFor(() => {
      expect(
        view.getByRole('dialog', { name: t('whatsNew.title', { version: '0.9.0' }) }),
      ).toBeTruthy();
    });
    const sidebarUpdateBtn = view.container.querySelector(
      'button.sidebar-updates-button',
    ) as HTMLButtonElement;
    expect(sidebarUpdateBtn.disabled).toBe(true);

    // 2. Requesting Updates via menu while WhatsNew is open defers Updates until WhatsNew closes.
    act(() => {
      mockBundle.emitMenuCommand('updates:open');
    });
    expect(view.getAllByRole('dialog')).toHaveLength(1);
    expect(
      view.getByRole('dialog', { name: t('whatsNew.title', { version: '0.9.0' }) }),
    ).toBeTruthy();

    // Closing WhatsNew calls dismissWhatsNew() and immediately promotes the queued Updates modal.
    fireEvent.click(view.getByRole('button', { name: t('whatsNew.done') }));
    expect(mockBundle.calls.dismissWhatsNew).toBe(1);
    await waitFor(() => {
      expect(view.getByRole('dialog', { name: t('common.updates') })).toBeTruthy();
    });
    expect(view.getAllByRole('dialog')).toHaveLength(1);

    // Close Updates modal.
    fireEvent.click(view.getByRole('button', { name: t('common.closeDialog') }));
    expect(view.queryByRole('dialog')).toBeNull();

    // 3. Opening KeyMigration via Overview reminder renders KeyMigration as the sole dialog.
    fireEvent.click(view.getByRole('button', { name: t('keys.review') }));
    expect(view.getAllByRole('dialog')).toHaveLength(1);
    expect(view.getByRole('dialog', { name: t('keys.title') })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: t('common.closeDialog') }));
    expect(view.queryByRole('dialog')).toBeNull();

    // 4. Opening ServerEditor via menu command renders ServerEditor and commits normalized ServerConfig.
    act(() => {
      mockBundle.emitMenuCommand('server:add');
    });
    const editorDialog = view.getByRole('dialog', { name: t('editor.addTitle') });
    expect(view.getAllByRole('dialog')).toHaveLength(1);

    fireEvent.click(within(editorDialog).getByRole('button', { name: t('editor.bearPreset') }));
    await act(async () => {
      fireEvent.click(within(editorDialog).getByRole('button', { name: t('editor.apply') }));
    });
    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    const saved = lastSavedConfig(mockBundle);
    expect(saved.mcpServers.bear).toMatchObject({
      command: '/Applications/Bear.app/Contents/MacOS/bearcli',
      args: ['mcp-server'],
      disabled: false,
    });
    await waitFor(() => {
      expect(view.queryByRole('dialog')).toBeNull();
    });
  });
});
