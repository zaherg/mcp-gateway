import { join } from "node:path";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  PATHS,
  Tray,
  Utils,
} from "electrobun/main";
import { parseConfig } from "../core/config";
import { McpGatewayController } from "../core/controller";
import { GatewayError } from "../core/errors";
import type { AppRPC, QuitStatus } from "../shared/rpc";
import { AppUpdater, resolveUpdateSupport, unsupportedUpdateStatus } from "./app-updater";
import { InteractiveQuitGate, QuitCoordinator } from "./lifecycle";
import {
  configurationDirectory,
  observeNativeQuitSignals,
  openLoginManager,
  restoreWindow,
  startsInBackground,
} from "./native";
import { AppService } from "./service";

const dataDirectory = configurationDirectory(Utils.paths.config);
const nativeQuitSignal = observeNativeQuitSignals(
  join(PATHS.RESOURCES_FOLDER, "app/native/login.dylib"),
);
const login = openLoginManager(join(PATHS.RESOURCES_FOLDER, "app/native/login.dylib"));
const controller = await McpGatewayController.open(join(dataDirectory, "mcp.json"));
const idleQuitStatus: QuitStatus = { attempt: 0, phase: "idle", error: null };
let quit: QuitCoordinator | undefined;
const quitStatus = (): QuitStatus => quit?.status() ?? idleQuitStatus;
const support = await resolveUpdateSupport();
let updates: AppUpdater | undefined;
const tray = new Tray({ image: "views://assets/tray.png", template: true, width: 18, height: 18 });
let window: BrowserWindow | undefined;
let pendingShowUpdates = false;
let windowReady = false;
let menuState = "";
let trayRemoved = false;
let loginClosed = false;
let requestInteractiveRendererQuit: (() => Promise<boolean>) | undefined;

function menuAction(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || !("data" in event)) return;
  const data = event.data;
  if (typeof data !== "object" || data === null || !("action" in data)) return;
  return typeof data.action === "string" ? data.action : undefined;
}

function updateMenu(): void {
  if (trayRemoved) return;
  const quitFailed = quitStatus().phase === "failed";
  const snapshot = controller.snapshot();
  const update = updates?.status() ?? unsupportedUpdateStatus();
  const state = `${snapshot.running}:${Boolean(snapshot.configError)}:${quitFailed}:${update.supported}:${update.phase}:${update.availableVersion ?? ""}`;
  if (state === menuState) return;
  menuState = state;
  const updateLabel =
    update.phase === "ready"
      ? `Update ready: ${update.availableVersion ?? "review"}`
      : update.phase === "available"
        ? `Update available: ${update.availableVersion ?? "review"}`
        : "Check for Updates…";
  tray.setMenu([
    {
      type: "normal",
      label: quitFailed
        ? "Cleanup failed: see settings"
        : snapshot.running
          ? "Gateway running"
          : "Gateway stopped",
      enabled: false,
    },
    { type: "normal", label: "Open settings…", action: "open" },
    ...(update.supported
      ? [{ type: "normal" as const, label: updateLabel, action: "updates" }]
      : []),
    {
      type: "normal",
      label: snapshot.running ? "Stop gateway" : "Start gateway",
      action: "toggle",
      enabled: !snapshot.configError,
    },
    { type: "divider" },
    { type: "normal", label: "Quit MCP Gateway", action: "quit" },
  ]);
}

function showUpdatesSection(): void {
  if (!support.supported) return;
  pendingShowUpdates = true;
  openWindow();
  void service.handlers.updatesCheck();
  if (windowReady) {
    pendingShowUpdates = false;
    dispatchShowUpdates();
  }
}

function dispatchShowUpdates(): void {
  window?.webview.executeJavascript('window.dispatchEvent(new Event("mcp-gateway:show-updates"))');
}

function openWindow(): void {
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
    title: "MCP Gateway",
    url: "views://mainview/index.html",
    rpc,
    frame: { width: 1120, height: 820 },
    renderer: "native",
    allowedProtocols: { views: true, appData: false },
    // Pinned native matcher uses last-match-wins; unmatched URLs otherwise default allow.
    navigationRules: JSON.stringify(["^*", "views://mainview/index.html"]),
  });
  window = created;
  created.on("close", () => {
    if (window === created) {
      window = undefined;
      windowReady = false;
      requestInteractiveRendererQuit = undefined;
      Utils.setDockIconVisible(false);
    }
  });
}

const refresh = setInterval(updateMenu, 1_000);
quit = new QuitCoordinator(
  async () => {
    updates?.stop();
    clearInterval(refresh);
    await controller.close();
    if (!trayRemoved) {
      tray.remove();
      trayRemoved = true;
    }
    if (!loginClosed) {
      login.close();
      loginClosed = true;
    }
  },
  () => {
    Utils.quit();
  },
  (error, kind) => {
    controller.recordLocalError(error);
    console.error(
      kind === "update"
        ? "Update handoff failed; the gateway is stopped."
        : "Gateway cleanup failed; the app has not quit.",
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
updates = updater;
updates.subscribe(updateMenu);
const service = new AppService(
  controller,
  login.manager,
  Utils.clipboardWriteText,
  {
    requestQuit: () => {
      quit?.armQuit();
      Utils.quit();
      return quitStatus();
    },
    quitStatus,
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
      type: "error",
      title: "Quit acknowledgement unavailable",
      message: "The application could not confirm whether the window received Quit.",
      detail:
        "Check the window's status before retrying. A missing acknowledgement does not authorize discarding drafts.",
      buttons: ["OK"],
    }).catch((failure) => controller.recordLocalError(failure));
  },
  nativeQuitSignal,
);
Electrobun.events.on("before-quit", (event) =>
  interactiveQuit.handle(() => {
    event.response = { allow: false };
  }),
);
Electrobun.events.on("reopen", openWindow);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    quit?.armQuit();
    Utils.quit();
  });

async function dispatch(event: unknown): Promise<void> {
  switch (menuAction(event)) {
    case "open":
      openWindow();
      break;
    case "updates":
      showUpdatesSection();
      break;
    case "toggle": {
      const result = await (controller.snapshot().running
        ? service.handlers.stop()
        : service.handlers.start());
      if (!result.ok) openWindow();
      updateMenu();
      break;
    }
    case "close-window":
      window?.close();
      break;
    case "quit":
      Utils.quit();
      break;
  }
}
tray.on("tray-clicked", (event) => {
  void dispatch(event).catch(() => console.error("Tray action failed."));
});
ApplicationMenu.setApplicationMenu([
  {
    label: "MCP Gateway",
    submenu: [
      { label: "Settings…", action: "open", accelerator: "Cmd+," },
      ...(support.supported ? [{ label: "Check for Updates…", action: "updates" }] : []),
      { type: "divider" },
      { label: "Quit MCP Gateway", action: "quit", accelerator: "Cmd+Q" },
    ],
  },
  {
    label: "File",
    submenu: [{ label: "Close Window", action: "close-window", accelerator: "Cmd+W" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "divider" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);
ApplicationMenu.on("application-menu-clicked", (event) => {
  void dispatch(event).catch(() => console.error("Menu action failed."));
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
const background = startsInBackground(
  process.argv.includes("--background"),
  login.manager.status(),
  savedLoginPreference,
);
if (!background) openWindow();
