import { existsSync } from 'node:fs';
import { join } from 'node:path';

import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  BuildConfig,
  PATHS,
  Screen,
  Tray,
  Utils,
} from 'electrobun/main';

import { parseConfig } from '@mcp-gateway/core/config';
import { McpGatewayController } from '@mcp-gateway/core/controller';
import { GatewayError } from '@mcp-gateway/core/errors';
import { AppUpdater, resolveUpdateSupport } from '@mcp-gateway/main/app-updater';
import { KeyReminderStore } from '@mcp-gateway/main/key-reminder';
import { openKeychain } from '@mcp-gateway/main/keychain';
import { LanguageStore } from '@mcp-gateway/main/language';
import { InteractiveQuitGate, QuitCoordinator } from '@mcp-gateway/main/lifecycle';
import {
  configurationDirectory,
  installedIdentifier,
  observeNativeQuitSignals,
  openLoginManager,
  openMinimumWindowSize,
  openTrayIndicator,
  preventIdleSleep,
  readPreferredLanguages,
  restoreWindow,
} from '@mcp-gateway/main/native';
import { AppService } from '@mcp-gateway/main/service';
import { WhatsNewStore } from '@mcp-gateway/main/whats-new';
import { clampWindowSize, MIN_WINDOW_SIZE, WindowSizeStore } from '@mcp-gateway/main/window-size';
import { CATALOG_LOCALES, resolveLocale } from '@mcp-gateway/shared/i18n';
import { appNameFor, TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import type { AppRPC } from '@mcp-gateway/shared/rpc';

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
const windowSize = await WindowSizeStore.open(dataDirectory);
// Opening the controller creates the folder on a first launch, so look before it does.
const existingInstall = existsSync(dataDirectory);
const controller = await McpGatewayController.open(
  join(dataDirectory, 'mcp.json'),
  () => preventIdleSleep(nativeLibrary),
  // Unsigned development builds share the real configuration folder but never touch Keychain.
  isDevelopment ? undefined : openKeychain(identifier),
  // A different first-run port lets the Dev app run beside the production app.
  identifier === TEST_IDENTIFIER ? 8766 : 8765,
);
const keyReminder = await KeyReminderStore.open(dataDirectory, existingInstall);
let preferredLanguages: string[] = [];
try {
  preferredLanguages = readPreferredLanguages(nativeLibrary);
} catch (error) {
  // The default locale is a working fallback; the failure stays visible in Logs.
  controller.recordLocalError(error);
}
const language = await LanguageStore.open(dataDirectory, resolveLocale(preferredLanguages), [
  ...CATALOG_LOCALES,
]);
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
let window: BrowserWindow | undefined;
let pendingShowUpdates = false;
let windowReady = false;
let menuState = '';
let trayRunning = false;
let trayIndicatorFailed = false;
let trayRemoved = false;
let requestInteractiveRendererQuit: (() => Promise<boolean>) | undefined;

const menuAction = (event: unknown): string | undefined => {
  if (typeof event !== 'object' || event === null || !('data' in event)) return;
  const data = event.data;
  if (typeof data !== 'object' || data === null || !('action' in data)) return;
  return typeof data.action === 'string' ? data.action : undefined;
};

const updateMenu = (): void => {
  if (trayRemoved) return;
  const quitFailed = quit.status().phase === 'failed';
  const snapshot = controller.snapshot();
  if (snapshot.running !== trayRunning) {
    try {
      setTrayRunning(snapshot.running);
      trayRunning = snapshot.running;
      trayIndicatorFailed = false;
    } catch (error) {
      // Keep the old state so the next refresh retries; report once per failure streak.
      if (!trayIndicatorFailed) controller.recordLocalError(error);
      trayIndicatorFailed = true;
    }
  }
  const update = updater.status();
  const t = language.translate;
  const state = `${language.state.locale}:${snapshot.running}:${snapshot.configError?.code ?? ''}:${quitFailed}:${update.supported}:${update.phase}:${update.availableVersion ?? ''}`;
  if (state === menuState) return;
  menuState = state;
  const updateLabel =
    update.phase === 'ready'
      ? t('native.tray.updateReady', {
          version: update.availableVersion ?? t('native.tray.review'),
        })
      : update.phase === 'available'
        ? t('native.tray.updateAvailable', {
            version: update.availableVersion ?? t('native.tray.review'),
          })
        : t('native.menu.checkForUpdates');
  tray.setMenu([
    {
      type: 'normal',
      label: quitFailed
        ? t('native.tray.cleanupFailed')
        : snapshot.running
          ? t('common.gatewayRunning')
          : t('common.gatewayStopped'),
      enabled: false,
    },
    { type: 'normal', label: t('native.tray.open'), action: 'open' },
    ...(update.supported
      ? [{ type: 'normal' as const, label: updateLabel, action: 'updates' }]
      : []),
    {
      type: 'normal',
      label: snapshot.running ? t('common.stopGateway') : t('common.startGateway'),
      action: 'toggle',
      // Start retries an unreadable stored key, for example after unlocking Keychain.
      enabled: !snapshot.configError || snapshot.configError.code === 'KeyUnavailable',
    },
    { type: 'divider' },
    { type: 'normal', label: t('common.quitApp', { app: appName }), action: 'quit' },
  ]);
};

const showUpdatesSection = (): void => {
  if (!support.supported) return;
  pendingShowUpdates = true;
  openWindow();
  void service.handlers.updatesCheck();
  if (windowReady) {
    pendingShowUpdates = false;
    dispatchShowUpdates();
  }
};

const dispatchShowUpdates = (): void => {
  window?.webview.executeJavascript('window.dispatchEvent(new Event("mcp-gateway:show-updates"))');
};

// A saved size from a larger display must not open beyond the current one.
const initialWindowSize = (): { width: number; height: number } => {
  const saved = windowSize.current;
  if (!saved) return MIN_WINDOW_SIZE;
  const area = Screen.getPrimaryDisplay().workArea;
  if (area.width <= 0 || area.height <= 0) return saved;
  return {
    width: Math.max(MIN_WINDOW_SIZE.width, Math.min(saved.width, area.width)),
    height: Math.max(MIN_WINDOW_SIZE.height, Math.min(saved.height, area.height)),
  };
};

const openWindow = (): void => {
  if (window) {
    restoreWindow(window);
    return;
  }
  Utils.setDockIconVisible(true);
  let ready = false;
  const rpc = BrowserView.defineRPC<AppRPC>({
    handlers: {
      requests: {
        ...service.handlers,
        snapshot: async (input: unknown) => {
          const result = await service.handlers.snapshot(input);
          if (!ready) {
            ready = true;
            windowReady = true;
          }
          if (pendingShowUpdates) {
            pendingShowUpdates = false;
            dispatchShowUpdates();
          }
          return result;
        },
      },
      messages: {},
    },
  });
  requestInteractiveRendererQuit = () =>
    rpc.request.interactiveQuit(undefined, { maxRequestTime: 5_000 });
  const created = new BrowserWindow({
    title: appName,
    url: viewUrl,
    rpc,
    frame: initialWindowSize(),
    titleBarStyle: 'hiddenInset',
    renderer: 'native',
    allowedProtocols: { views: true, appData: false },
    // Pinned native matcher uses last-match-wins; unmatched URLs otherwise default allow.
    navigationRules: JSON.stringify(['^*', viewUrl]),
  });
  window = created;
  try {
    setMinimumWindowSize(created, MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height);
  } catch (error) {
    controller.recordLocalError(error);
  }
  created.on('resize', () => {
    if (window !== created) return;
    try {
      // Events can arrive after a newer resize; always constrain the live size.
      const current = created.getSize();
      if (
        !Number.isFinite(current.width) ||
        !Number.isFinite(current.height) ||
        current.width <= 0 ||
        current.height <= 0
      )
        return;
      const size = clampWindowSize(current);
      if (size.width !== current.width || size.height !== current.height)
        created.setSize(size.width, size.height);
      windowSize.schedule(size);
    } catch (error) {
      controller.recordLocalError(error);
    }
  });
  created.on('close', () => {
    void windowSize.flush();
    if (window === created) {
      window = undefined;
      windowReady = false;
      requestInteractiveRendererQuit = undefined;
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
    await windowSize.flush();
    await controller.close();
    if (!trayRemoved) {
      tray.remove();
      trayRemoved = true;
    }
    login.close();
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
updater.subscribe(updateMenu);
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
    openExternal: Utils.openExternal,
    showItemInFolder: Utils.showItemInFolder,
    openPath: Utils.openPath,
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
    },
  },
  updater,
);
const interactiveQuit = new InteractiveQuitGate(
  quit,
  () => {
    if (!window) return undefined;
    restoreWindow(window);
    return windowReady && requestInteractiveRendererQuit
      ? requestInteractiveRendererQuit()
      : Promise.resolve(false);
  },
  () => Utils.quit(),
  (error) => {
    controller.recordLocalError(error);
    openWindow();
    const t = language.translate;
    void Utils.showMessageBox({
      type: 'error',
      title: t('native.quitAck.title'),
      message: t('native.quitAck.message'),
      detail: t('native.quitAck.detail'),
      buttons: [t('native.quitAck.ok')],
    }).catch((failure) => controller.recordLocalError(failure));
  },
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

const dispatch = async (event: unknown): Promise<void> => {
  switch (menuAction(event)) {
    case 'open':
      openWindow();
      break;
    case 'updates':
      showUpdatesSection();
      break;
    case 'toggle': {
      const result = await (controller.snapshot().running
        ? service.handlers.stop()
        : service.handlers.start());
      if (!result.ok) openWindow();
      updateMenu();
      break;
    }
    case 'open-devtools':
      if (isDevelopment) {
        openWindow();
        // The pinned native toggle can crash when closing an open inspector.
        window?.webview.openDevTools();
      }
      break;
    case 'close-window':
      window?.close();
      break;
    case 'open-docs': {
      const result = await service.handlers.openSocialLink({ target: 'docs' });
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
  void dispatch(event).catch(() => console.error('Tray action failed.'));
});
const setApplicationMenu = (): void => {
  const t = language.translate;
  ApplicationMenu.setApplicationMenu([
    {
      label: appName,
      submenu: [
        { label: t('native.menu.settings'), action: 'open', accelerator: 'Cmd+,' },
        ...(support.supported
          ? [{ label: t('native.menu.checkForUpdates'), action: 'updates' }]
          : []),
        { type: 'divider' },
        { label: t('common.quitApp', { app: appName }), action: 'quit', accelerator: 'Cmd+Q' },
      ],
    },
    {
      label: t('native.menu.file'),
      submenu: [
        { label: t('native.menu.closeWindow'), action: 'close-window', accelerator: 'Cmd+W' },
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
        { label: t('native.menu.guide'), action: 'open-docs' },
        { label: t('native.menu.revealConfig'), action: 'reveal-config' },
      ],
    },
  ]);
};
setApplicationMenu();
ApplicationMenu.on('application-menu-clicked', (event) => {
  void dispatch(event).catch(() => console.error('Menu action failed.'));
});
Utils.setDockIconVisible(false);
updateMenu();
try {
  await updater.start();
  updateMenu();
} catch (error) {
  controller.recordLocalError(error);
}
let savedLoginPreference = false;
try {
  savedLoginPreference =
    parseConfig(controller.snapshot().configText, process.env, controller.snapshot().configFormat)
      .gateway.launchAtLogin === true;
} catch (error) {
  // Expected invalid config is already visible in the controller snapshot.
  if (!(error instanceof GatewayError)) throw error;
}
const background =
  process.argv.includes('--background') || login.manager.status().enabled || savedLoginPreference;
// Unread release notes take precedence over background startup until dismissed.
const showReleaseNotes = whatsNew.pending !== null;
if (!background || showReleaseNotes) {
  openWindow();
  if (showReleaseNotes && window) restoreWindow(window);
}
