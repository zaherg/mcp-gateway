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
import { InteractiveQuitGate, QuitCoordinator } from '@mcp-gateway/main/lifecycle';
import {
  configurationDirectory,
  installedIdentifier,
  observeNativeQuitSignals,
  openLoginManager,
  openMinimumWindowSize,
  openTrayIndicator,
  restoreWindow,
} from '@mcp-gateway/main/native';
import { AppService } from '@mcp-gateway/main/service';
import { clampWindowSize, MIN_WINDOW_SIZE, WindowSizeStore } from '@mcp-gateway/main/window-size';
import type { AppRPC } from '@mcp-gateway/shared/rpc';

const buildConfig = BuildConfig.getSync();
const isDevelopment = buildConfig.channel === 'dev';
const developmentServerUrl = buildConfig.runtime?.developmentServerUrl;
// Packaged builds must never grant the RPC bridge to a development server.
const viewUrl =
  isDevelopment && typeof developmentServerUrl === 'string'
    ? developmentServerUrl
    : 'views://mainview/index.html';
const dataDirectory = configurationDirectory(
  Utils.paths.config,
  installedIdentifier(PATHS.RESOURCES_FOLDER),
);
const nativeLibrary = join(PATHS.RESOURCES_FOLDER, 'app/native/login.dylib');
const nativeQuitSignal = observeNativeQuitSignals(nativeLibrary);
const login = openLoginManager(nativeLibrary);
const setMinimumWindowSize = openMinimumWindowSize(nativeLibrary);
const windowSize = await WindowSizeStore.open(dataDirectory);
const controller = await McpGatewayController.open(join(dataDirectory, 'mcp.json'));
const support = await resolveUpdateSupport();
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
  const state = `${snapshot.running}:${Boolean(snapshot.configError)}:${quitFailed}:${update.supported}:${update.phase}:${update.availableVersion ?? ''}`;
  if (state === menuState) return;
  menuState = state;
  const updateLabel =
    update.phase === 'ready'
      ? `Update ready: ${update.availableVersion ?? 'review'}`
      : update.phase === 'available'
        ? `Update available: ${update.availableVersion ?? 'review'}`
        : 'Check for Updates…';
  tray.setMenu([
    {
      type: 'normal',
      label: quitFailed
        ? 'Cleanup failed: see settings'
        : snapshot.running
          ? 'Gateway running'
          : 'Gateway stopped',
      enabled: false,
    },
    { type: 'normal', label: 'Open settings…', action: 'open' },
    ...(update.supported
      ? [{ type: 'normal' as const, label: updateLabel, action: 'updates' }]
      : []),
    {
      type: 'normal',
      label: snapshot.running ? 'Stop gateway' : 'Start gateway',
      action: 'toggle',
      enabled: !snapshot.configError,
    },
    { type: 'divider' },
    { type: 'normal', label: 'Quit MCP Gateway', action: 'quit' },
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
    title: 'MCP Gateway',
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
    void Utils.showMessageBox({
      type: 'error',
      title: 'Quit acknowledgement unavailable',
      message: 'The application could not confirm whether the window received Quit.',
      detail:
        "Check the window's status before retrying. A missing acknowledgement does not authorize discarding drafts.",
      buttons: ['OK'],
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
    case 'quit':
      Utils.quit();
      break;
  }
};
tray.on('tray-clicked', (event) => {
  void dispatch(event).catch(() => console.error('Tray action failed.'));
});
ApplicationMenu.setApplicationMenu([
  {
    label: 'MCP Gateway',
    submenu: [
      { label: 'Settings…', action: 'open', accelerator: 'Cmd+,' },
      ...(support.supported ? [{ label: 'Check for Updates…', action: 'updates' }] : []),
      { type: 'divider' },
      { label: 'Quit MCP Gateway', action: 'quit', accelerator: 'Cmd+Q' },
    ],
  },
  {
    label: 'File',
    submenu: [{ label: 'Close Window', action: 'close-window', accelerator: 'Cmd+W' }],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'divider' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  },
  ...(isDevelopment
    ? [
        {
          label: 'Developer',
          submenu: [
            {
              label: 'Open Developer Tools',
              action: 'open-devtools',
              accelerator: 'Cmd+Option+I',
            },
          ],
        },
      ]
    : []),
]);
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
if (!background) openWindow();
