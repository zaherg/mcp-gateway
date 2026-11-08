import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { InteractiveQuitGate } from "./interactive-quit";
import { QuitCoordinator } from "./lifecycle";
import { openLoginManager } from "./login";
import { observeNativeQuitSignals } from "./native-signals";
import {
  configurationDirectory,
  desktopPlatform,
  handleWindowClose,
  restoreWindow,
  startsInBackground,
} from "./platform";
import { AppService } from "./service";
import { applyVerifiedUpdate, loadApplySdk } from "./updater/apply";
import { INSTALLATION_ENABLED, UpdaterSafetyBoundary } from "./updater/boundary";
import { UPDATER_CHANNEL, UPDATER_IDENTIFIER } from "./updater/constants";
import { UpdaterCoordinator } from "./updater/coordinator";
import { EXECUTING_BUILD } from "./updater/executing-build";
import type { ApplySettlement } from "./updater/handoff";
import { asOrdinaryQuit, withQuitInvocation } from "./updater/invocation";
import { readUpdateSupport } from "./updater/support";
import type { UpdateAttempt } from "./updater/transaction";

const updaterWorkerMode = process.env.MCP_GATEWAY_UPDATE_WORKER;
if (updaterWorkerMode) {
  const { runUpdaterWorker } = await import("./updater/worker");
  process.exit(await runUpdaterWorker(updaterWorkerMode));
}

const platform = desktopPlatform(process.platform);
const dataDirectory = configurationDirectory(platform, homedir(), process.env, Utils.paths.config);
const nativeQuitSignal = observeNativeQuitSignals(
  platform,
  join(PATHS.RESOURCES_FOLDER, "app/native/login.dylib"),
);
const login = openLoginManager(platform, join(PATHS.RESOURCES_FOLDER, "app/native/login.dylib"));
const controller = await McpGatewayController.open(join(dataDirectory, "mcp.json"));
const idleQuitStatus: QuitStatus = { attempt: 0, phase: "idle", error: null };
let quit: QuitCoordinator | undefined;
const quitStatus = (): QuitStatus => quit?.status() ?? idleQuitStatus;
const appBundlePath = resolve(dirname(process.execPath), "..", "..");
const updateSupport = await readUpdateSupport({
  platform,
  appBundlePath,
});
const boundary = updateSupport.supported
  ? new UpdaterSafetyBoundary({
      appBundlePath,
      executingBuild: EXECUTING_BUILD,
      dataDirectory,
      appDataDirectory: Utils.paths.appData,
      channelRoot: join(Utils.paths.appData, UPDATER_IDENTIFIER, UPDATER_CHANNEL),
    })
  : undefined;
const updates = new UpdaterCoordinator({
  dataDirectory,
  supported: boundary !== undefined,
  installedVersion: updateSupport.installedVersion,
  installationEnabled: INSTALLATION_ENABLED,
  runtime: boundary
    ? {
        checkForUpdate: () => boundary.checkForUpdate(),
        prepareUpdateAttempt: () => boundary.prepareUpdateAttempt(),
        revalidate: (candidate, signal) => boundary.revalidate(candidate, signal),
        reconcile: () => boundary.reconcile(),
        abandonPrepared: () => boundary.abandonPrepared(),
        cancel: () => boundary.cancel(),
      }
    : undefined,
  terminal: {
    reserveUpdate: (candidate) => quit?.reserveUpdate(candidate),
    requestRestartToUpdate: (attempt: UpdateAttempt) => {
      const accepted = quit?.acceptUpdateRestart(attempt) === true;
      if (accepted)
        withQuitInvocation({ kind: "begin-update-shutdown", attemptId: attempt.id }, () =>
          Utils.quit(),
        );
      return { accepted, status: quitStatus() };
    },
    cancelUpdate: (attemptId) => quit?.cancelUpdate(attemptId),
  },
});
const service = new AppService(
  controller,
  login.manager,
  Utils.clipboardWriteText,
  {
    platform,
    requestQuit: () => {
      asOrdinaryQuit(() => {
        quit?.armQuit();
        Utils.quit();
      });
      return quitStatus();
    },
    quitStatus,
  },
  updates,
);
const tray = new Tray({ image: "views://assets/tray.png", template: true, width: 18, height: 18 });
let window: BrowserWindow | undefined;
let pendingShowUpdates = false;
let windowReady = false;
let updateStartup: Promise<void> | undefined;
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
  const update = updates.statusValue();
  const state = `${snapshot.running}:${Boolean(snapshot.configError)}:${quitFailed}:${update.supported}:${update.phase}:${update.availableVersion ?? ""}`;
  if (state === menuState) return;
  menuState = state;
  const updateLabel =
    update.phase === "ready"
      ? `Update ready: ${update.readyVersion ?? update.availableVersion ?? "review"}`
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
  if (!updateSupport.supported) return;
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

function completeUpdateStartup(): Promise<void> {
  updateStartup ??= (async () => {
    await updates.completeInitialization();
    updateMenu();
  })().catch((error) => controller.recordLocalError(error));
  return updateStartup;
}

function openWindow(): void {
  if (window) {
    restoreWindow(window);
    return;
  }
  if (platform === "macos") Utils.setDockIconVisible(true);
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
            void completeUpdateStartup();
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
  created.on("will-close", (event) => {
    handleWindowClose(platform, event, created);
  });
  created.on("close", () => {
    if (window === created) {
      window = undefined;
      windowReady = false;
      requestInteractiveRendererQuit = undefined;
      if (platform === "macos") Utils.setDockIconVisible(false);
    }
  });
}

const refresh = setInterval(updateMenu, 1_000);
quit = new QuitCoordinator(
  async () => {
    updates.stop();
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
  (error, kind, settlement) => {
    controller.recordLocalError(error);
    if (kind === "update") updates.markHandoffFailed(quitStatus().error ?? undefined, settlement);
    console.error(
      kind === "update"
        ? "Update handoff failed; the gateway is stopped."
        : "Gateway cleanup failed; the app has not quit.",
    );
    updateMenu();
    // Cleanup may already have removed the tray; retain a visible retry path.
    openWindow();
  },
  async (attempt): Promise<ApplySettlement> => {
    if (!boundary) throw new Error("Update handoff is unavailable");
    const sdk = await loadApplySdk();
    const session = await boundary.prepareHandoff(attempt, sdk);
    if (!quit?.registerHandoff(session)) {
      session.releaseGuard();
      throw new Error("Update handoff session is no longer current");
    }
    let retained = false;
    try {
      const outcome = await applyVerifiedUpdate(attempt, session, sdk);
      if (outcome.settlement.kind === "unarmed") retained = true;
      return outcome.settlement;
    } finally {
      quit?.unregisterHandoff(session);
      if (!retained) session.releaseGuard();
    }
  },
  async () => {
    await updates.abandonPrepared();
  },
);
boundary?.setHandoffAuthority(quit.handoffAuthority);
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
    asOrdinaryQuit(() => {
      quit?.armQuit();
      Utils.quit();
    });
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
if (platform === "macos")
  ApplicationMenu.setApplicationMenu([
    {
      label: "MCP Gateway",
      submenu: [
        { label: "Settings…", action: "open", accelerator: "Cmd+," },
        ...(updateSupport.supported ? [{ label: "Check for Updates…", action: "updates" }] : []),
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
if (platform === "macos") Utils.setDockIconVisible(false);
updateMenu();
try {
  await updates.start({ reconcile: false });
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
  platform,
  process.argv.includes("--background"),
  login.manager.status(),
  savedLoginPreference,
);
if (!background) openWindow();
if (!window) await completeUpdateStartup();
