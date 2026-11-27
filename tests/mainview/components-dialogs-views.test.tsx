import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { EditorView } from '@codemirror/view';
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
import { CONFIG_TOO_LARGE, MAX_CONFIG_BYTES } from '@mcp-gateway/shared/config-document';
import { translator } from '@mcp-gateway/shared/i18n';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type {
  ConfigFile,
  KeyMigration as KeyMigrationSlots,
  LogEntry,
  LogPage,
} from '@mcp-gateway/shared/types';
import { cleanupDom, installDomEnvironment } from '../helpers/dom';
import {
  createMockAppClient,
  DEFAULT_REVISION,
  type MockClientBundle,
  makeConfigText,
  makeGatewaySnapshot,
  makeSnapshot,
  makeUpdateStatus,
  SECOND_REVISION,
  setInputValue,
  setNavigatorLanguages,
} from '../helpers/mainview';

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
const { RawConfig } = await import('@mcp-gateway/mainview/views/RawConfig');
const { Settings } = await import('@mcp-gateway/mainview/views/Settings');
const { Updates } = await import('@mcp-gateway/mainview/views/Updates');
const { App } = await import('@mcp-gateway/mainview/App');

const t = translator('en_US');
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

const getCodeMirrorView = (container: HTMLElement): EditorView => {
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

afterEach(() => {
  cleanupDom();
  setNavigatorLanguages(defaultLanguages);
  document.documentElement.lang = '';
});

describe('Shared UI components (src/mainview/components/ui.tsx)', () => {
  test('Alert renders roles, optional action buttons, and calls onDismiss', () => {
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
    expect(alerts[1]?.textContent).toContain('Warning notice');

    const status = view.getByRole('status');
    expect(status.textContent).toContain('Saved successfully');

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

  test('Toggle invokes onChange on click and respects disabled', () => {
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

    expect(disabledSwitch.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(disabledSwitch);
    expect(onDisabledChange).toHaveBeenCalledTimes(0);
  });

  test('CheckboxRow invokes onChange on click and respects disabled', () => {
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

    expect(disabledCheckbox.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(disabledCheckbox);
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
  test('KeyMigration renders masked secret badges (SEC-04), freezes reviewed slots, supports Back and singular moveOne, and handles move/failure/keep/dirty', async () => {
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

    // Step 1 -> Step 2 -> Back returns to Step 1.
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.continue') }));
    expect(dialog.textContent).toContain(t('keys.step2'));
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.back') }));
    expect(dialog.textContent).toContain(t('keys.step1'));

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

    // Single-slot migration renders singular `t('keys.moveOne')` button on step 2.
    view.rerender(
      <I18nProvider>
        <KeyMigration
          slots={{ gateway: true, servers: [] }}
          dirty={false}
          busy={false}
          error={null}
          filename="mcp.json"
          fallbackFocus={fallbackFocus}
          onKeep={onKeep}
          onClose={onClose}
          onMove={onMove}
        />
      </I18nProvider>,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: t('keys.continue') }));

    // Successful move transitions to done and closes on Done.
    moveShouldSucceed = true;
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: t('keys.moveOne') }));
    });
    expect(movedSlots[1]).toEqual({ gateway: true, servers: [] });
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

  test('WhatsNew renders release note blocks for a valid version, strips markdown links to plain text, hides unknown versions, and calls onClose', async () => {
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
    cleanupDom();

    // Markdown links `[Documentation](https://example.com/docs)` render as plain text without `<a>`.
    const realChangelog = await import('@mcp-gateway/shared/changelog');
    const origChangelogBlocks = realChangelog.changelogBlocks;
    const origChangelogSection = realChangelog.changelogSection;
    mock.module('@mcp-gateway/shared/changelog', () => ({
      changelogBlocks: origChangelogBlocks,
      changelogSection: (raw: string, version: string) =>
        version === '0.9.9-link'
          ? '### Added\n\n- Read the [Documentation](https://example.com/docs) for details'
          : origChangelogSection(raw, version),
    }));
    try {
      const linkView = renderWithI18n(
        <WhatsNew version="0.9.9-link" onClose={onClose} fallbackFocus={fallbackFocus} />,
      );
      const linkDialog = linkView.getByRole('dialog', {
        name: t('whatsNew.title', { version: '0.9.9-link' }),
      });
      expect(linkDialog.textContent).toContain('Read the Documentation for details');
      expect(linkDialog.querySelector('a')).toBeNull();
    } finally {
      mock.module('@mcp-gateway/shared/changelog', () => ({
        changelogBlocks: origChangelogBlocks,
        changelogSection: origChangelogSection,
      }));
    }
  });

  test('ServerEditor renders stdio/http structured rows, sensitiveEnvOverrides warning (SEC-03), Bear preset, validation UI state, and submits', () => {
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

    // Invalid env (duplicate key), duplicate name, and invalid name each disable Apply and show inline alert.
    const nameInput = within(dialog).getByLabelText(t('editor.name')) as HTMLInputElement;
    const applyBtn = within(dialog).getByRole('button', {
      name: t('editor.apply'),
    }) as HTMLButtonElement;

    setInputValue(must(keyInputs[1]), 'PATH');
    expect(within(dialog).getByText(t('app.environmentInvalid'))).toBeTruthy();
    expect(applyBtn.disabled).toBe(true);
    setInputValue(must(keyInputs[1]), 'HOME');

    setInputValue(nameInput, 'existing');
    expect(within(dialog).getByText(t('app.serverExists'))).toBeTruthy();
    expect(applyBtn.disabled).toBe(true);

    setInputValue(nameInput, 'bad/name');
    expect(within(dialog).getByText(t('app.serverFieldsInvalid'))).toBeTruthy();
    expect(applyBtn.disabled).toBe(true);

    // Fix name back to unique valid name and submit stdio configuration.
    setInputValue(nameInput, 'bear_notes');
    expect(applyBtn.disabled).toBe(false);
    fireEvent.click(applyBtn);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.name).toBe('bear_notes');

    // Switch transport to HTTP and edit URL + custom auth key.
    const transportSelect = within(dialog).getByLabelText(
      t('editor.transport'),
    ) as HTMLSelectElement;
    fireEvent.change(transportSelect, { target: { value: 'http' } });
    const urlInput = within(dialog).getByLabelText(t('editor.url')) as HTMLInputElement;
    setInputValue(urlInput, 'https://mcp.example.com/sse');

    const authSelect = within(dialog).getByLabelText(t('editor.auth')) as HTMLSelectElement;
    fireEvent.change(authSelect, { target: { value: 'custom' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('editor.generateKey') }));
    const keyField = within(dialog).getByLabelText(t('editor.key')) as HTMLInputElement;
    expect(keyField.type).toBe('password');
    expect(keyField.value).toMatch(/^[0-9a-f]{64}$/);
    fireEvent.click(within(dialog).getByRole('button', { name: t('editor.showKey') }));
    expect(keyField.type).toBe('text');
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
    expect(mockBundle.calls.testServer).toEqual([
      { name: 'bear', expectedRevision: DEFAULT_REVISION },
    ]);
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

  test('Overview renders repair state for InvalidConfig, hides repair panel on KeySetupFailed, dismisses operationalError per occurrenceId, and invalidates passed ServerTest badges while preserving cancelled results', async () => {
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

    // KeySetupFailed hides the "Repair configuration to continue" panel.
    act(() => {
      brokenBundle.emitSnapshot(
        makeSnapshot({
          gateway: {
            configText: '',
            configError: {
              occurrenceId: 'cfg-key-setup-1',
              code: 'KeySetupFailed',
              message: 'Keychain locked',
            },
          },
        }),
      );
    });
    expect(brokenView.queryByText(t('overview.repairTitle'))).toBeNull();
    cleanupDom();

    const configText = makeConfigText({
      bear: { command: '/usr/bin/env', args: ['bear'] },
    });
    let testMode: 'pass' | 'cancel' = 'pass';
    const liveBundle = createMockAppClient(
      makeSnapshot({
        gateway: {
          running: true,
          configText,
          operationalError: {
            occurrenceId: 'op-err-1',
            code: 'ListenerFailure',
            message: 'Address 127.0.0.1:8787 already in use',
          },
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
      {
        testServer: async () =>
          testMode === 'pass'
            ? { ok: true, value: { protocolVersion: '2025-11-25' } }
            : { ok: false, error: { code: 'Cancelled', message: 'Test cancelled by stop' } },
      },
    );

    const liveView = renderWithGateway(liveBundle.client, <Overview />);
    await waitFor(() => {
      expect(liveView.getByText('bear')).toBeTruthy();
    });

    // operationalError banner renders and dismisses per occurrenceId; a new occurrenceId re-renders.
    const opAlert = liveView.getByRole('alert');
    expect(opAlert.textContent).toContain('ListenerFailure: Address 127.0.0.1:8787 already in use');
    fireEvent.click(within(opAlert).getByRole('button', { name: t('common.dismissError') }));
    expect(liveView.queryByRole('alert')).toBeNull();

    act(() => {
      liveBundle.emitSnapshot(
        makeSnapshot({
          gateway: {
            running: true,
            configText,
            operationalError: {
              occurrenceId: 'op-err-2',
              code: 'ListenerFailure',
              message: 'Second bind failure',
            },
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
    });
    expect(liveView.getByRole('alert').textContent).toContain(
      'ListenerFailure: Second bind failure',
    );

    // A passed ServerTest badge clears when the server unmounts or becomes disabled (`outdated`).
    await act(async () => {
      fireEvent.click(
        liveView.getByRole('button', { name: t('overview.testConnectionFor', { name: 'bear' }) }),
      );
    });
    expect(liveView.getByText(t('overview.testPassed', { version: '2025-11-25' }))).toBeTruthy();

    act(() => {
      liveBundle.emitSnapshot(
        makeSnapshot({
          gateway: {
            running: true,
            configText,
            servers: [
              {
                name: 'bear',
                type: 'stdio',
                endpoint: '/mcp/bear',
                enabled: false,
                status: 'disabled',
                error: null,
              },
            ],
          },
        }),
      );
    });
    await waitFor(() => {
      expect(liveView.queryByText(t('overview.testPassed', { version: '2025-11-25' }))).toBeNull();
    });

    // Re-mount server, run a test that returns `Cancelled`, then stop gateway: `cancelled` badge stays.
    testMode = 'cancel';
    act(() => {
      liveBundle.emitSnapshot(
        makeSnapshot({
          gateway: {
            running: true,
            configText,
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
    });
    await act(async () => {
      fireEvent.click(
        liveView.getByRole('button', { name: t('overview.testConnectionFor', { name: 'bear' }) }),
      );
    });
    expect(liveView.getByText('Test cancelled by stop')).toBeTruthy();

    act(() => {
      liveBundle.emitSnapshot(
        makeSnapshot({
          gateway: {
            running: false,
            configText,
            servers: [
              {
                name: 'bear',
                type: 'stdio',
                endpoint: '/mcp/bear',
                enabled: true,
                status: 'stopped',
                error: null,
              },
            ],
          },
        }),
      );
    });
    expect(liveView.getByText('Test cancelled by stop')).toBeTruthy();
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

  test('Settings renders needsLoginRetry error + retry button, replaces Keychain tokenRef on Generate, and shows paused state when config is invalid', async () => {
    const tokenRefConfigText = JSON.stringify(
      {
        gateway: {
          host: '127.0.0.1',
          port: 8787,
          tokenRef: 'gateway:default',
          launchAtLogin: true,
        },
        mcpServers: {},
      },
      null,
      2,
    );
    const mockBundle = createMockAppClient(
      makeSnapshot({
        login: { supported: true, enabled: false, error: 'Approval required' },
        gateway: {
          configText: tokenRefConfigText,
        },
      }),
    );

    const view = renderWithGateway(mockBundle.client, <Settings />);
    await waitFor(() => {
      expect(view.getByText('Approval required')).toBeTruthy();
    });

    // needsLoginRetry renders the retry button and clicking it re-saves launchAtLogin: true.
    const retryBtn = view.getByRole('button', { name: t('draft.retryLogin') });
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    expect(lastSavedConfig(mockBundle).gateway.launchAtLogin).toBe(true);

    // tokenRef displays "Stored in Keychain" instead of the password input, and Generate replaces it with a literal token.
    expect(view.getByText(t('keys.stored'))).toBeTruthy();
    expect(view.queryByLabelText(t('settings.token'))).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: t('settings.generateToken') }));
    });
    expect(mockBundle.calls.saveConfig).toHaveLength(2);
    const afterGenerate = lastSavedConfig(mockBundle);
    expect(afterGenerate.gateway.tokenRef).toBeUndefined();
    expect(afterGenerate.gateway.token).toMatch(/^[0-9a-f]{64}$/);
    expect((view.getByLabelText(t('settings.token')) as HTMLInputElement).value).toBe(
      afterGenerate.gateway.token ?? '',
    );

    // Invalid config pauses structured preferences.
    act(() => {
      mockBundle.emitSnapshot(
        makeSnapshot({
          gateway: {
            configText: '{ invalid',
            configError: {
              occurrenceId: 'cfg-err-paused',
              code: 'InvalidConfig',
              message: 'Malformed JSON',
            },
          },
        }),
      );
    });
    expect(view.getByText(t('settings.paused'))).toBeTruthy();
  });

  test('Updates auto-checks once on idle mount, renders version/auto-check/Check/1-click Install & Relaunch (D-02), and determinate progress bar (D-17)', async () => {
    // Mounting Updates when phase === 'idle' and supported === true auto-triggers updatesCheck() once.
    const idleBundle = createMockAppClient(
      makeSnapshot({
        update: {
          supported: true,
          phase: 'idle',
          checkedAt: null,
        },
      }),
    );
    const idleView = renderWithGateway(idleBundle.client, <Updates />);
    await waitFor(() => {
      expect(idleBundle.calls.updatesCheck).toBe(1);
    });
    expect(idleView.getByRole('status').textContent).toBe(t('updates.status.upToDate'));
    cleanupDom();

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
    expect(mockBundle.calls.updatesCheck).toBe(0);

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

  test('Logs renders Console rows, filters by search/level/server, focuses search on Cmd+F, polls hasMore/gap pages, handles clearLogs failure, and auto-retries after readLogs failure (Plan 034)', async () => {
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
    let clearMode: 'fail-result' | 'throw' | 'ok' = 'fail-result';
    let currentGeneration = 1;
    let ringEntries: LogEntry[] = entries;
    const scheduledPoll: { current: (() => void) | null } = { current: null };
    const realSetTimeout = globalThis.setTimeout;

    const mockBundle = createMockAppClient(makeSnapshot(), {
      readLogs: async (params): Promise<AppResult<LogPage>> => {
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
            value: {
              entries: ringEntries.slice(0, 2),
              cursor: 2,
              generation: currentGeneration,
              gap: true,
              hasMore: true,
            },
          };
        }
        if (readCalls === 3) {
          return {
            ok: true,
            value: {
              entries: ringEntries.slice(2),
              cursor: 3,
              generation: currentGeneration,
              gap: false,
              hasMore: false,
            },
          };
        }
        return {
          ok: true,
          value: {
            entries: params.after === 0 ? ringEntries : [],
            cursor: ringEntries.length,
            generation: currentGeneration,
            gap: false,
            hasMore: false,
          },
        };
      },
      clearLogs: async (): Promise<AppResult<LogPage>> => {
        clearCalls += 1;
        if (clearMode === 'fail-result') {
          return {
            ok: false,
            error: { code: 'ClearDenied', message: 'Log ring locked' },
          };
        }
        if (clearMode === 'throw') {
          throw new Error('Bridge disconnected');
        }
        ringEntries = [];
        currentGeneration += 1;
        return {
          ok: true,
          value: {
            entries: [],
            cursor: 0,
            generation: currentGeneration,
            gap: false,
            hasMore: false,
          },
        };
      },
    });

    // Capture the 2000ms polling timer so Plan 034 retry is verified deterministically without sleeping,
    // while `delay = 0` (`hasMore: true`) executes immediately via `realSetTimeout`.
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

      // Trigger the scheduled retry poll -> returns page 1 (`gap: true, hasMore: true`), which
      // renders `t('logs.gap')` and immediately polls page 2 (`delay = 0`), rendering all 3 rows.
      const runRetry = must(scheduledPoll.current, 'scheduled poll');
      scheduledPoll.current = null;
      await act(async () => {
        runRetry();
      });

      await waitFor(() => {
        expect(view.queryByRole('alert')).toBeNull();
        expect(view.container.querySelectorAll('.log-row')).toHaveLength(3);
      });
      expect(readCalls).toBe(3);
      expect(view.getByRole('status').textContent).toBe(t('logs.gap'));
      expect(view.getByText('Mounted bear stdio backend')).toBeTruthy();
      expect(
        view.getByText(`Connection timeout talking to remote (${t('logs.truncated')})`),
      ).toBeTruthy();
      expect(view.getByText(t('logs.appSource'))).toBeTruthy();

      // Cmd+F focuses the log search input.
      const searchInput = view.getByLabelText(t('logs.search')) as HTMLInputElement;
      expect(document.activeElement === searchInput).toBe(false);
      fireEvent.keyDown(window, { key: 'f', metaKey: true });
      expect(document.activeElement === searchInput).toBe(true);

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
      setInputValue(searchInput, 'LISTENER');
      expect(view.container.querySelectorAll('.log-row')).toHaveLength(1);
      expect(view.getByText('Gateway listener retrying bind')).toBeTruthy();

      setInputValue(searchInput, 'does-not-exist');
      expect(view.getByText(t('logs.noMatches'))).toBeTruthy();
      setInputValue(searchInput, '');

      // Failed clearLogs (`{ ok: false }` and bridge rejection) displays error alert and re-reads rows.
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: t('logs.clear') }));
      });
      expect(clearCalls).toBe(1);
      expect(view.getByRole('alert').textContent).toContain('ClearDenied: Log ring locked');
      expect(view.container.querySelectorAll('.log-row')).toHaveLength(3);

      clearMode = 'throw';
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: t('logs.clear') }));
      });
      expect(clearCalls).toBe(2);
      expect(view.getByRole('alert').textContent).toContain(t('logs.clearFailed'));
      expect(view.container.querySelectorAll('.log-row')).toHaveLength(3);

      // Clear logs succeeds and resets to empty state.
      clearMode = 'ok';
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: t('logs.clear') }));
      });
      expect(clearCalls).toBe(3);
      await waitFor(() => {
        expect(view.getByText(t('logs.empty'))).toBeTruthy();
      });

      view.unmount();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('RawConfig view (src/mainview/views/RawConfig.tsx)', () => {
  test('mounts CodeMirror with configText, syncs edits, and runs 300ms debounced validation for ok, issue with Line N jump, local syntax error, oversized draft, and bridge rejection keeping Save enabled', async () => {
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

    const view = renderWithGateway(mockBundle.client, <RawConfig visible={true} />);

    await waitFor(() => {
      expect(view.getByText(t('raw.title'))).toBeTruthy();
    });
    fireEvent.click(must(view.container.querySelector('button.raw-heading'), 'raw-heading'));
    expect(view.container.querySelector('.raw-code-editor .cm-editor')).not.toBeNull();
    const cmView = getCodeMirrorView(view.container);
    expect(cmView.state.doc.toString()).toBe(initialText);

    const saveButton = () =>
      view.getByRole('button', {
        name: t('raw.save', { filename: 'mcp.json' }),
      }) as HTMLButtonElement;
    const resetButton = () =>
      view.getByRole('button', { name: t('raw.reset') }) as HTMLButtonElement;

    // Initial clean document runs validation after 300ms debounce, reports checked, and keeps Save disabled (not dirty).
    await waitFor(() => {
      expect(view.getByRole('status').textContent).toBe(t('raw.checked'));
    });
    expect(saveButton().disabled).toBe(true);
    expect(resetButton().disabled).toBe(true);

    // 1. Dispatch a CodeMirror document transaction -> dirty becomes true, and after 300ms debounce
    // validateConfig returns { issue: null } -> feedback shows raw.checked and Save is enabled.
    const editedValidText = makeConfigText(
      { bear: { command: '/usr/bin/env', args: ['bear'] } },
      { port: 9090 },
    );
    act(() => {
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: editedValidText },
      });
    });
    expect(resetButton().disabled).toBe(false);

    await waitFor(() => {
      expect(mockBundle.calls.validateConfig.at(-1)?.text).toBe(editedValidText);
      expect(view.getByRole('status').textContent).toBe(t('raw.checked'));
    });
    expect(saveButton().disabled).toBe(false);

    // 2. When validateConfig returns an issue with offset, feedback displays raw.issueAt,
    // renders a clickable `Line N` jump button, marks editor content aria-invalid="true", and disables Save.
    validateMode = 'issue';
    const portIssueText = makeConfigText({}, { port: 99999 });
    act(() => {
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: portIssueText },
      });
    });

    await waitFor(() => {
      expect(view.getByRole('status').textContent).toContain('Port must be between 1 and 65535.');
    });
    expect(saveButton().disabled).toBe(true);
    expect(cmView.contentDOM.getAttribute('aria-invalid')).toBe('true');

    const lineJumpBtn = view.getByRole('button', { name: /^Line \d+$/ });
    fireEvent.click(lineJumpBtn);
    const targetLineNumber = Number(lineJumpBtn.textContent?.replace('Line ', ''));
    expect(cmView.state.doc.lineAt(cmView.state.selection.main.anchor).number).toBe(
      targetLineNumber,
    );

    // 3. Local JSON syntax error ('{') reports the syntax issue with line/column after debounce
    // without calling client.validateConfig.
    const callsBeforeSyntaxError = mockBundle.calls.validateConfig.length;
    act(() => {
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: '{' },
      });
    });

    await waitFor(() => {
      expect(view.getByRole('status').textContent).toContain('line 1');
    });
    expect(mockBundle.calls.validateConfig.length).toBe(callsBeforeSyntaxError);
    expect(saveButton().disabled).toBe(true);
    expect(cmView.contentDOM.getAttribute('aria-invalid')).toBe('true');

    // 4. Draft exceeding MAX_CONFIG_BYTES reports CONFIG_TOO_LARGE without calling validateConfig.
    const oversizedText = `"${'x'.repeat(MAX_CONFIG_BYTES + 16)}"`;
    act(() => {
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: oversizedText },
      });
    });
    await waitFor(() => {
      expect(view.getByRole('status').textContent).toBe(CONFIG_TOO_LARGE);
    });
    expect(mockBundle.calls.validateConfig.length).toBe(callsBeforeSyntaxError);
    expect(saveButton().disabled).toBe(true);

    // 5. When validateConfig rejects (bridge error), feedback displays raw.checkUnavailable
    // and Save remains enabled (saveReady === true) so authoritative native Save can still run.
    validateMode = 'reject';
    const bridgeFallbackText = makeConfigText({}, { port: 8899 });
    act(() => {
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: bridgeFallbackText },
      });
    });

    await waitFor(() => {
      expect(view.getByRole('status').textContent).toBe(t('raw.checkUnavailable'));
    });
    expect(saveButton().disabled).toBe(false);
  });

  test('Format, Reset, Save, Import from Claude / Cursor (0, 1, 2 server notices), and Schema reference toggle', async () => {
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

    const view = renderWithGateway(mockBundle.client, <RawConfig visible={true} />);

    await waitFor(() => {
      expect(view.getByText(t('raw.title'))).toBeTruthy();
    });
    fireEvent.click(must(view.container.querySelector('button.raw-heading'), 'raw-heading'));
    expect(view.container.querySelector('.raw-code-editor .cm-editor')).not.toBeNull();
    const cmView = getCodeMirrorView(view.container);
    expect(cmView.state.doc.toString()).toBe(compactJson);

    // Schema reference popover toggles open and closed.
    const schemaBtn = view.getByRole('button', { name: 'Schema reference' });
    expect(schemaBtn.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.schema-popover')).toBeNull();

    fireEvent.click(schemaBtn);
    expect(schemaBtn.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.schema-popover')?.textContent).toContain(t('raw.intro'));

    fireEvent.click(schemaBtn);
    expect(schemaBtn.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.schema-popover')).toBeNull();

    // Import from Claude / Cursor displays 0, 1, and 2 imported server notices.
    const importBtn = view.getByRole('button', { name: 'Import from Claude / Cursor' });
    importedCount = 0;
    await act(async () => {
      fireEvent.click(importBtn);
    });
    expect(view.getByRole('status').textContent).toBe(
      'No new servers found in Claude Desktop or Cursor.',
    );

    importedCount = 1;
    await act(async () => {
      fireEvent.click(importBtn);
    });
    expect(view.getByRole('status').textContent).toBe(
      'Imported 1 server from Claude Desktop / Cursor.',
    );

    importedCount = 2;
    await act(async () => {
      fireEvent.click(importBtn);
    });
    expect(view.getByRole('status').textContent).toBe(
      'Imported 2 servers from Claude Desktop / Cursor.',
    );

    // Clicking Format on compact valid JSON reformats the CodeMirror document with 2-space indentation and marks dirty: true.
    fireEvent.click(view.getByRole('button', { name: t('raw.format') }));
    const formattedText = cmView.state.doc.toString();
    expect(formattedText).toContain('\n  "gateway": {\n    "host": "127.0.0.1"');
    const resetBtn = view.getByRole('button', { name: t('raw.reset') }) as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(false);

    // Clicking Reset triggers discardRawConfig (client.confirmDiscard) and restores the clean on-disk document.
    await act(async () => {
      fireEvent.click(resetBtn);
    });
    expect(mockBundle.calls.confirmDiscard).toBe(1);
    expect(cmView.state.doc.toString()).toBe(compactJson);
    expect(resetBtn.disabled).toBe(true);

    // Format again, wait for debounced validation to pass, and click Save to commit via client.saveConfig.
    fireEvent.click(view.getByRole('button', { name: t('raw.format') }));
    const saveBtn = view.getByRole('button', {
      name: t('raw.save', { filename: 'mcp.json' }),
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(mockBundle.calls.saveConfig).toHaveLength(1);
    expect(mockBundle.calls.saveConfig[0]?.text).toBe(formattedText);
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

    // 4. Opening ServerEditor via menu command renders ServerEditor as the sole dialog.
    act(() => {
      mockBundle.emitMenuCommand('server:add');
    });
    expect(view.getByRole('dialog', { name: t('editor.addTitle') })).toBeTruthy();
    expect(view.getAllByRole('dialog')).toHaveLength(1);
  });
});
