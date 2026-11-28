import { existsSync } from 'node:fs';
import { join } from 'node:path';

import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  BuildConfig,
  PATHS,
  Tray,
  Utils,
} from 'electrobun/main';

import { parseConfig } from '@mcp-gateway/core/config';
import { McpGatewayController } from '@mcp-gateway/core/controller';
import { GatewayError } from '@mcp-gateway/core/errors';
import { AppUpdater, resolveUpdateSupport } from '@mcp-gateway/main/app-updater';
import { AppearanceStore } from '@mcp-gateway/main/appearance';
import { KeyReminderStore } from '@mcp-gateway/main/key-reminder';
import { openKeychain } from '@mcp-gateway/main/keychain';
import { LanguageStore } from '@mcp-gateway/main/language';
import {
  InteractiveQuitGate,
  QuitCoordinator,
  WindowRevealCoordinator,
} from '@mcp-gateway/main/lifecycle';
import {
  configurationDirectory,
  installedIdentifier,
  observeNativeQuitSignals,
  openLoginManager,
  openMinimumWindowSize,
  openTrayIndicator,
  openWindowDrag,
  postNativeNotification,
  preventIdleSleep,
  readPreferredLanguages,
  restoreWindow,
} from '@mcp-gateway/main/native';
import { AppService } from '@mcp-gateway/main/service';
import { WhatsNewStore } from '@mcp-gateway/main/whats-new';
import { editConfigDocument, SAFE_NAME } from '@mcp-gateway/shared/config-document';
import { CATALOG_LOCALES, resolveLocale } from '@mcp-gateway/shared/i18n';
import { appNameFor, TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import type { AppRPC, MenuCommand } from '@mcp-gateway/shared/rpc';

const MIN_WINDOW_SIZE = { width: 1120, height: 820 } as const;
const MENU_COMMANDS: ReadonlySet<MenuCommand> = new Set([
  'tab:overview',
  'tab:logs',
  'tab:settings',
  'tab:raw-config',
  'server:add',
  'updates:open',
  'gateway:reload',
]);

const isMenuCommand = (value: string): value is MenuCommand =>
  MENU_COMMANDS.has(value as MenuCommand);

const originalBunServe = Bun.serve.bind(Bun);
Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  if (
    options &&
    typeof options === 'object' &&
    !('unix' in options && options.unix) &&
    !('hostname' in options && options.hostname)
  ) {
    return originalBunServe({
      ...options,
      unix: undefined,
      hostname: '127.0.0.1',
    } as Parameters<typeof Bun.serve>[0]);
  }
  return originalBunServe(options);
}) as typeof Bun.serve;

const buildConfig = BuildConfig.getSync();
const isDevelopment = buildConfig.channel === 'dev';
const developmentServerUrl = buildConfig.runtime?.developmentServerUrl;
// Packaged builds must never grant the RPC bridge to a development server.
const viewUrl =
  isDevelopment && typeof developmentServerUrl === 'string'
    ? developmentServerUrl
    : 'views://mainview/index.html';
const identifier = installedIdentifier(PATHS.RESOURCES_FOLDER);
const appName = appNameFor(identifier);
const dataDirectory = configurationDirectory(Utils.paths.config, identifier);
const nativeLibrary = join(PATHS.RESOURCES_FOLDER, 'app/native/login.dylib');
const nativeQuitSignal = observeNativeQuitSignals(nativeLibrary);
const login = openLoginManager(nativeLibrary);
const setMinimumWindowSize = openMinimumWindowSize(nativeLibrary);
const startNativeWindowDrag = openWindowDrag(nativeLibrary);
// Opening the controller creates the folder on a first launch, so look before it does.
const existingInstall = existsSync(dataDirectory);
const defaultPort = identifier === TEST_IDENTIFIER ? 8766 : 8765;
const controller = await McpGatewayController.open(
  join(dataDirectory, 'mcp.json'),
  () => preventIdleSleep(nativeLibrary),
  // Unsigned development builds share the real configuration folder but never touch Keychain.
  isDevelopment ? undefined : openKeychain(identifier),
  // A different first-run port lets the Dev app run beside the production app.
  defaultPort,
);
const notifyBackground = (body: string) => {
  postNativeNotification(appName, body, nativeLibrary, (error) =>
    controller.recordLocalError(error),
  );
};
const keyReminder = await KeyReminderStore.open(dataDirectory, existingInstall);
const preferredLanguages = (() => {
  try {
    return readPreferredLanguages(nativeLibrary);
  } catch (error) {
    // The default locale is a working fallback; the failure stays visible in Logs.
    controller.recordLocalError(error);
    return [];
  }
})();
const language = await LanguageStore.open(dataDirectory, resolveLocale(preferredLanguages), [
  ...CATALOG_LOCALES,
]);
const appearance = await AppearanceStore.open(dataDirectory);
const support = await resolveUpdateSupport();
const whatsNew = await WhatsNewStore.open(dataDirectory, support.installedVersion, existingInstall);
const TRAY_SIZE = 18;
const tray = new Tray({
  image: 'views://assets/tray.png',
  template: true,
  width: TRAY_SIZE,
  height: TRAY_SIZE,
});
const setTrayRunning = openTrayIndicator(
  join(PATHS.VIEWS_FOLDER, 'assets/tray.png'),
  TRAY_SIZE,
  nativeLibrary,
);

type WindowRPC = ReturnType<typeof BrowserView.defineRPC<AppRPC>>;

const desktopState: {
  window: BrowserWindow | undefined;
  rpc: WindowRPC | undefined;
  pendingMenuCommand: MenuCommand | undefined;
  windowReveal: WindowRevealCoordinator | undefined;
  menuState: string;
  lastSnapshotKey: string;
  trayRunning: boolean;
  trayIndicatorFailed: boolean;
  trayRemoved: boolean;
  hasUnsavedRawConfig: (() => Promise<boolean>) | undefined;
} = {
  window: undefined,
  rpc: undefined,
  pendingMenuCommand: undefined,
  windowReveal: undefined,
  menuState: '',
  lastSnapshotKey: '',
  trayRunning: false,
  trayIndicatorFailed: false,
  trayRemoved: false,
  hasUnsavedRawConfig: undefined,
};

const menuAction = (event: unknown) => {
  if (typeof event !== 'object' || event === null || !('data' in event)) return;
  const data = event.data;
  if (typeof data !== 'object' || data === null || !('action' in data)) return;
  return typeof data.action === 'string' ? data.action : undefined;
};

const removeTray = () => {
  if (!desktopState.trayRemoved) {
    tray.remove();
    desktopState.trayRemoved = true;
  }
};

const gatewayBaseEndpoint = () => {
  const active = controller.activeConfig();
  const host = active?.gateway.host ?? '127.0.0.1';
  const port = active?.gateway.port ?? defaultPort;
  return `http://${host}:${port}`;
};

const pushSnapshot = () => {
  if (!desktopState.window || !desktopState.windowReveal?.isReady() || !desktopState.rpc) return;
  try {
    desktopState.rpc.send.snapshotChanged(service.currentSnapshot());
  } catch (error) {
    controller.recordLocalError(error);
  }
};

const sendMenuCommand = (command: MenuCommand) => {
  desktopState.pendingMenuCommand = command;
  openWindow();
  if (desktopState.windowReveal?.isReady() && desktopState.rpc) {
    desktopState.pendingMenuCommand = undefined;
    try {
      desktopState.rpc.send.menuCommand({ command });
    } catch (error) {
      controller.recordLocalError(error);
    }
  }
};

const updateMenu = () => {
  if (desktopState.trayRemoved) return;
  const quitFailed = quit.status().phase === 'failed';
  const snapshot = controller.snapshot();
  if (snapshot.running !== desktopState.trayRunning) {
    try {
      setTrayRunning(snapshot.running);
      desktopState.trayRunning = snapshot.running;
      desktopState.trayIndicatorFailed = false;
    } catch (error) {
      // Keep the old state so the next refresh retries; report once per failure streak.
      if (!desktopState.trayIndicatorFailed) controller.recordLocalError(error);
      desktopState.trayIndicatorFailed = true;
    }
  }
  const update = updater.status();
  const t = language.translate;
  const active = controller.activeConfig();
  const hostPort = `${active?.gateway.host ?? '127.0.0.1'}:${active?.gateway.port ?? defaultPort}`;
  const serversKey = snapshot.servers
    .map((server) => `${server.name}:${server.status}:${server.enabled}`)
    .join(',');
  const state = [
    language.state.locale,
    snapshot.running,
    hostPort,
    snapshot.revision,
    snapshot.configError?.occurrenceId ?? '',
    snapshot.operationalError?.occurrenceId ?? '',
    serversKey,
    quitFailed,
    update.supported,
    update.phase,
    update.availableVersion ?? '',
    update.progressPercent ?? '',
    update.error ?? '',
  ].join('|');

  if (state !== desktopState.lastSnapshotKey) {
    desktopState.lastSnapshotKey = state;
    pushSnapshot();
  }

  if (state === desktopState.menuState) return;
  desktopState.menuState = state;

  const statusHeader = quitFailed
    ? t('native.tray.cleanupFailed')
    : snapshot.running
      ? `${t('common.gatewayRunning')} — ${hostPort}`
      : t('common.gatewayStopped');

  const serverItems = snapshot.servers.map((server) => {
    const icon = server.status === 'mounted' ? '●' : server.status === 'error' ? '⚠' : '○';
    const statusLabel =
      server.status === 'mounted'
        ? t('overview.status.mounted')
        : server.status === 'error'
          ? t('overview.status.error')
          : server.status === 'disabled'
            ? t('overview.status.disabled')
            : t('overview.status.stopped');
    return {
      type: 'normal' as const,
      label: `${icon} ${server.name} (${statusLabel})`,
      action: `toggle-server:${server.name}`,
      enabled: !snapshot.configError,
    };
  });

  const updateItem = !update.supported
    ? []
    : update.phase === 'ready'
      ? [
          {
            type: 'normal' as const,
            label: `Restart to Update (${update.availableVersion ?? t('native.tray.review')})`,
            action: 'update-restart',
          },
        ]
      : [
          {
            type: 'normal' as const,
            label:
              update.phase === 'available'
                ? t('native.tray.updateAvailable', {
                    version: update.availableVersion ?? t('native.tray.review'),
                  })
                : t('native.menu.checkForUpdates'),
            action: 'updates',
          },
        ];

  tray.setMenu([
    {
      type: 'normal',
      label: statusHeader,
      enabled: false,
    },
    {
      type: 'normal',
      label: snapshot.running ? t('common.stopGateway') : t('common.startGateway'),
      action: 'toggle',
      // Start retries an unreadable stored key, for example after unlocking Keychain.
      enabled: !snapshot.configError || snapshot.configError.code === 'KeyUnavailable',
    },
    {
      type: 'normal',
      label: 'Copy Gateway Endpoint URL',
      action: 'copy-gateway-endpoint',
      enabled: snapshot.running,
    },
    { type: 'divider' },
    ...serverItems,
    ...(serverItems.length > 0 ? [{ type: 'divider' as const }] : []),
    ...updateItem,
    { type: 'normal', label: `Open ${appName}`, action: 'open' },
    { type: 'divider' },
    { type: 'normal', label: t('common.quitApp', { app: appName }), action: 'quit' },
  ]);
};

const showUpdatesSection = () => {
  if (!support.supported) return;
  sendMenuCommand('updates:open');
  void service.handlers
    .updatesCheck()
    .then(() => {
      updateMenu();
      pushSnapshot();
    })
    .catch((error) => controller.recordLocalError(error));
};

const wrapHandler = <Args extends unknown[], Res>(
  handler: (...args: Args) => Promise<Res>,
  notifiesSnapshot = true,
) => {
  return async (...args: Args) => {
    const result = await handler(...args);
    if (notifiesSnapshot) {
      updateMenu();
      pushSnapshot();
    }
    return result;
  };
};

const openWindow = () => {
  if (desktopState.window) {
    if (desktopState.windowReveal?.isVisible()) restoreWindow(desktopState.window);
    return;
  }
  Utils.setDockIconVisible(true);
  let created: BrowserWindow<WindowRPC> | undefined;
  let reveal: WindowRevealCoordinator | undefined;
  const rpc = BrowserView.defineRPC<AppRPC>({
    handlers: {
      requests: {
        ...service.handlers,
        start: wrapHandler(service.handlers.start),
        stop: wrapHandler(service.handlers.stop),
        saveConfig: wrapHandler(service.handlers.saveConfig),
        importExternalServers: wrapHandler(service.handlers.importExternalServers),
        migrateKeys: wrapHandler(service.handlers.migrateKeys),
        dismissKeyReminder: wrapHandler(service.handlers.dismissKeyReminder),
        dismissWhatsNew: wrapHandler(service.handlers.dismissWhatsNew),
        updatesCheck: wrapHandler(service.handlers.updatesCheck),
        updatesDownload: wrapHandler(service.handlers.updatesDownload),
        updatesInstall: wrapHandler(service.handlers.updatesInstall),
        updatesSetAutomatic: wrapHandler(service.handlers.updatesSetAutomatic),
        setLanguage: wrapHandler(service.handlers.setLanguage),
        setAppearance: wrapHandler(service.handlers.setAppearance),
        updatesRestart: wrapHandler(service.handlers.updatesRestart),
        snapshot: async (input) => {
          const result = await service.handlers.snapshot(input);
          reveal?.onSnapshotSettled();
          if (desktopState.pendingMenuCommand) {
            const command = desktopState.pendingMenuCommand;
            desktopState.pendingMenuCommand = undefined;
            queueMicrotask(() => {
              try {
                rpc.send.menuCommand({ command });
              } catch (error) {
                controller.recordLocalError(error);
              }
            });
          }
          return result;
        },
      },
      messages: {
        startWindowDrag: () => {
          if (!created || desktopState.window !== created) return;
          try {
            startNativeWindowDrag(created);
          } catch (error) {
            controller.recordLocalError(error);
          }
        },
      },
    },
  });
  desktopState.rpc = rpc;
  desktopState.hasUnsavedRawConfig = () =>
    rpc.request.hasUnsavedRawConfig(undefined, { maxRequestTime: 1_500 });
  created = new BrowserWindow({
    title: appName,
    url: viewUrl,
    rpc,
    frame: MIN_WINDOW_SIZE,
    titleBarStyle: 'hiddenInset',
    renderer: 'native',
    hidden: true,
    allowedProtocols: { views: true, appData: false },
    // Pinned native matcher uses last-match-wins; unmatched URLs otherwise default allow.
    navigationRules: JSON.stringify(['^*', viewUrl]),
  });
  desktopState.window = created;
  reveal = new WindowRevealCoordinator(() => {
    if (created && desktopState.window === created) restoreWindow(created);
  });
  desktopState.windowReveal = reveal;
  try {
    setMinimumWindowSize(created, MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height);
  } catch (error) {
    controller.recordLocalError(error);
  }
  created.on('close', () => {
    reveal?.dispose();
    if (desktopState.window === created) {
      desktopState.window = undefined;
      desktopState.rpc = undefined;
      desktopState.windowReveal = undefined;
      desktopState.hasUnsavedRawConfig = undefined;
      Utils.setDockIconVisible(false);
    }
  });
};

const refresh = setInterval(updateMenu, 1_000);
// Constructed before any timer, menu or window callback above can run.
const quit = new QuitCoordinator(
  async () => {
    updater.stop();
    clearInterval(refresh);
    await controller.close();
    removeTray();
  },
  () => {
    Utils.quit();
  },
  (error, kind) => {
    controller.recordLocalError(error);
    console.error(
      kind === 'update'
        ? 'Update handoff failed; the gateway is stopped.'
        : 'Gateway cleanup failed; the app has not quit.',
    );
    updateMenu();
    pushSnapshot();
    // Cleanup may already have removed the tray; retain a visible retry path.
    openWindow();
  },
);
const updater = new AppUpdater({
  dataDirectory,
  supported: support.supported,
  installedVersion: support.installedVersion,
  quit,
});
let previousUpdatePhase = updater.status().phase;
updater.subscribe((status) => {
  const transitionedToReady = previousUpdatePhase !== 'ready' && status.phase === 'ready';
  previousUpdatePhase = status.phase;
  updateMenu();
  pushSnapshot();
  if (transitionedToReady && !desktopState.window) {
    const version = status.availableVersion ?? language.translate('native.tray.review');
    notifyBackground(language.translate('native.tray.updateReady', { version }));
  }
});
const service = new AppService(
  controller,
  login.manager,
  Utils.clipboardWriteText,
  {
    requestQuit: () => {
      quit.armQuit();
      Utils.quit();
      return quit.status();
    },
    quitStatus: () => quit.status(),
    openExternal: (url) => Boolean(Utils.openExternal(url)),
    showItemInFolder: Utils.showItemInFolder,
    openPath: (path) => Boolean(Utils.openPath(path)),
    confirmDiscard: async () => {
      const t = language.translate;
      const { response } = await Utils.showMessageBox({
        type: 'question',
        title: t('native.discard.title'),
        message: t('native.discard.message'),
        detail: t('native.discard.detail'),
        buttons: [t('common.cancel'), t('native.discard.confirm')],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
    confirmDeleteServer: async (name) => {
      const t = language.translate;
      const { response } = await Utils.showMessageBox({
        type: 'warning',
        title: t('confirm.deleteTitle'),
        message: t('confirm.deleteTitle'),
        detail: t('confirm.deleteBody', { name }),
        buttons: [t('common.cancel'), t('confirm.deleteAction')],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
    whatsNew: () => whatsNew.pending,
    dismissWhatsNew: () => whatsNew.dismiss(),
    keyReminderRetired: () => keyReminder.retired,
    retireKeyReminder: () => keyReminder.retire(),
    language: () => language.state,
    setLanguage: async (preference) => {
      await language.set(preference);
      // The tray key includes the locale, so the tray rebuilds; the app menu is rebuilt here.
      updateMenu();
      setApplicationMenu();
      pushSnapshot();
    },
    appearance: () => appearance.preference,
    setAppearance: async (preference) => {
      await appearance.set(preference);
      pushSnapshot();
    },
  },
  updater,
);
const interactiveQuit = new InteractiveQuitGate(
  quit,
  () =>
    desktopState.window && desktopState.windowReveal?.isReady() && desktopState.hasUnsavedRawConfig
      ? desktopState.hasUnsavedRawConfig()
      : undefined,
  async () => {
    if (desktopState.window) restoreWindow(desktopState.window);
    const t = language.translate;
    const { response } = await Utils.showMessageBox({
      type: 'question',
      title: t('confirm.quitTitle', { app: appName }),
      message: 'Quit with unsaved raw configuration edits?',
      detail: t('confirm.quitBody'),
      buttons: [t('common.cancel'), 'Quit and Discard'],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  },
  () => Utils.quit(),
  nativeQuitSignal,
);
Electrobun.events.on('before-quit', (event) =>
  interactiveQuit.handle(() => {
    event.response = { allow: false };
  }),
);
Electrobun.events.on('reopen', openWindow);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    quit.armQuit();
    Utils.quit();
  });

const toggleServerFromTray = async (name: string) => {
  if (!SAFE_NAME.test(name)) return;
  const snapshot = controller.snapshot();
  if (snapshot.configError) return;
  let parsed: ReturnType<typeof parseConfig>;
  try {
    parsed = parseConfig(snapshot.configText, process.env, snapshot.configFormat);
  } catch {
    return;
  }
  const server = Object.hasOwn(parsed.mcpServers, name) ? parsed.mcpServers[name] : undefined;
  if (!server) return;
  const nextText = editConfigDocument(
    snapshot.configText,
    {
      ...parsed,
      mcpServers: {
        ...parsed.mcpServers,
        [name]: { ...server, disabled: !server.disabled },
      },
    },
    snapshot.configFormat,
  );
  const result = await service.handlers.saveConfig({
    text: nextText,
    expectedRevision: snapshot.revision,
  });
  if (!result.ok && !desktopState.window) notifyBackground(result.error.message);
  updateMenu();
  pushSnapshot();
};

const dispatch = async (event: unknown) => {
  const action = menuAction(event);
  if (!action) return;
  if (action.startsWith('toggle-server:')) {
    const name = action.slice('toggle-server:'.length);
    await toggleServerFromTray(name);
    return;
  }
  if (action.startsWith('menu:')) {
    const command = action.slice('menu:'.length);
    if (isMenuCommand(command)) sendMenuCommand(command);
    return;
  }
  switch (action) {
    case 'open':
    case 'about':
      openWindow();
      break;
    case 'updates':
      showUpdatesSection();
      break;
    case 'update-restart': {
      const result = await service.handlers.updatesRestart();
      if (!result.ok) {
        if (!desktopState.window) notifyBackground(result.error.message);
      }
      updateMenu();
      pushSnapshot();
      break;
    }
    case 'copy-gateway-endpoint':
      Utils.clipboardWriteText(gatewayBaseEndpoint());
      break;
    case 'toggle': {
      const result = await (controller.snapshot().running
        ? service.handlers.stop()
        : service.handlers.start());
      if (!result.ok && !desktopState.window) notifyBackground(result.error.message);
      updateMenu();
      pushSnapshot();
      break;
    }
    case 'open-devtools':
      if (isDevelopment) {
        openWindow();
        // The pinned native toggle can crash when closing an open inspector.
        desktopState.window?.webview.openDevTools();
      }
      break;
    case 'close-window':
      desktopState.window?.close();
      break;
    case 'open-docs': {
      const result = await service.handlers.openSocialLink({ target: 'docs' });
      if (!result.ok) controller.recordLocalError(`${result.error.code}: ${result.error.message}`);
      break;
    }
    case 'open-github': {
      const result = await service.handlers.openSocialLink({ target: 'github' });
      if (!result.ok) controller.recordLocalError(`${result.error.code}: ${result.error.message}`);
      break;
    }
    case 'reveal-config': {
      const result = await service.handlers.revealConfig();
      if (!result.ok) controller.recordLocalError(`${result.error.code}: ${result.error.message}`);
      break;
    }
    case 'quit':
      Utils.quit();
      break;
  }
};
tray.on('tray-clicked', (event) => {
  void dispatch(event).catch((error) => {
    controller.recordLocalError(error);
    console.error('Tray action failed.');
  });
});
const setApplicationMenu = () => {
  const t = language.translate;
  ApplicationMenu.setApplicationMenu([
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { type: 'divider' },
        { label: t('native.menu.settings'), action: 'menu:tab:settings', accelerator: 'Cmd+,' },
        ...(support.supported
          ? [{ label: t('native.menu.checkForUpdates'), action: 'updates' }]
          : []),
        { type: 'divider' },
        { role: 'hide', label: `Hide ${appName}`, accelerator: 'Cmd+H' },
        { role: 'hideOthers', label: 'Hide Others', accelerator: 'Cmd+Option+H' },
        { role: 'unhide', label: 'Show All' },
        { type: 'divider' },
        { label: t('common.quitApp', { app: appName }), action: 'quit', accelerator: 'Cmd+Q' },
      ],
    },
    {
      label: t('native.menu.edit'),
      submenu: [
        { role: 'undo', label: t('native.menu.undo') },
        { role: 'redo', label: t('native.menu.redo') },
        { type: 'divider' },
        { role: 'cut', label: t('native.menu.cut') },
        { role: 'copy', label: t('native.menu.copy') },
        { role: 'paste', label: t('native.menu.paste') },
        { role: 'selectAll', label: t('native.menu.selectAll') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: t('overview.servers'), action: 'menu:tab:overview', accelerator: 'Cmd+1' },
        { label: t('shell.tab.logs'), action: 'menu:tab:logs', accelerator: 'Cmd+2' },
        { label: t('shell.tab.settings'), action: 'menu:tab:settings', accelerator: 'Cmd+3' },
        {
          label: t('raw.title'),
          action: 'menu:tab:raw-config',
          accelerator: 'Cmd+4',
        },
        { type: 'divider' },
        {
          label: 'Reload Configuration',
          action: 'menu:gateway:reload',
          accelerator: 'Cmd+R',
        },
      ],
    },
    {
      label: 'Server',
      submenu: [
        {
          label: `${t('overview.addServer')}…`,
          action: 'menu:server:add',
          accelerator: 'Cmd+N',
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize', label: 'Minimize', accelerator: 'Cmd+M' },
        { label: t('native.menu.closeWindow'), action: 'close-window', accelerator: 'Cmd+W' },
      ],
    },
    ...(isDevelopment
      ? [
          {
            label: t('native.menu.developer'),
            submenu: [
              {
                label: t('native.menu.devTools'),
                action: 'open-devtools',
                accelerator: 'Cmd+Option+I',
              },
            ],
          },
        ]
      : []),
    {
      label: t('native.menu.help'),
      submenu: [
        { label: 'Documentation', action: 'open-docs' },
        { label: t('native.menu.revealConfig'), action: 'reveal-config' },
        { label: 'GitHub Repository', action: 'open-github' },
      ],
    },
  ]);
};
setApplicationMenu();
ApplicationMenu.on('application-menu-clicked', (event) => {
  void dispatch(event).catch((error) => {
    controller.recordLocalError(error);
    console.error('Menu action failed.');
  });
});
Utils.setDockIconVisible(false);
updateMenu();
await updater.start().catch((error) => controller.recordLocalError(error));
updateMenu();
const initialSnapshot = controller.snapshot();
const savedLoginPreference = (() => {
  try {
    return (
      parseConfig(initialSnapshot.configText, process.env, initialSnapshot.configFormat).gateway
        .launchAtLogin === true
    );
  } catch (error) {
    // Expected invalid config is already visible in the controller snapshot.
    if (!(error instanceof GatewayError)) throw error;
    return false;
  }
})();
const background =
  process.argv.includes('--background') || login.manager.status().enabled || savedLoginPreference;
if (background) {
  const startupError = initialSnapshot.configError ?? initialSnapshot.operationalError;
  if (startupError) {
    notifyBackground(startupError.message);
    updateMenu();
  }
} else {
  openWindow();
}
