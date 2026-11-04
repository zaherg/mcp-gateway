import { mock, spyOn } from "bun:test";
import { resolve } from "node:path";
import { configFor, eventually, setup } from "../core/helpers";

const action = process.argv[2];
if (action !== "native" && action !== "menu" && action !== "signal")
  throw new Error("Unknown native-event fixture action");
const context = await setup(await configFor({}));
process.env.MCP_GATEWAY_ISOLATED = "1";
process.env.MCP_GATEWAY_DATA_DIR = context.directory;
delete process.env.MCP_GATEWAY_UPDATE_WORKER;
delete process.env.MCP_GATEWAY_SMOKE;

const handlers = new Map<
  string,
  (event: { data?: { action: string }; response?: { allow: boolean } }) => void
>();
let rendererDecisions = 0;
let cleanupStarted = 0;
const originalClose = context.controller.close.bind(context.controller);
spyOn(context.controller, "close").mockImplementation(async () => {
  cleanupStarted++;
  await originalClose();
});
const timers = new Set<ReturnType<typeof setInterval>>();
const originalInterval = setInterval;
const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
  new Proxy(originalInterval, {
    apply(target, receiver, args) {
      const timer = Reflect.apply(target, receiver, args);
      timers.add(timer);
      return timer;
    },
  }),
);
const initialSignals = new Set(process.listeners("SIGTERM"));
const events = {
  on(name: string, handler: (event: { response?: { allow: boolean } }) => void) {
    handlers.set(name, handler);
  },
};
const quit = () => handlers.get("before-quit")?.({});
class Window {
  webview = { executeJavascript() {} };
  on() {}
  unminimize() {}
  show() {}
  activate() {}
}
class Tray {
  setMenu() {}
  remove() {}
  on(name: string, handler: (event: { data?: { action: string } }) => void) {
    handlers.set(name, handler);
  }
}
mock.module("electrobun/main", () => ({
  default: { events },
  ApplicationMenu: {
    setApplicationMenu() {},
    on(name: string, handler: (event: { data?: { action: string } }) => void) {
      handlers.set(name, handler);
    },
  },
  BrowserWindow: Window,
  BrowserView: {
    defineRPC: () => ({
      request: new Proxy(
        {},
        {
          get: () => async () => {
            rendererDecisions++;
            return false;
          },
        },
      ),
    }),
  },
  Tray,
  PATHS: { RESOURCES_FOLDER: context.directory },
  Utils: {
    quit,
    setDockIconVisible() {},
    clipboardWriteText() {},
    paths: { config: context.directory, appData: context.directory },
  },
}));
const controllerModule = await import("../../src/core/controller");
mock.module(resolve("src/core/controller.ts"), () => ({
  ...controllerModule,
  McpGatewayController: { open: async () => context.controller },
}));
const loginStatus = { enabled: false, supported: false, error: null };
mock.module(resolve("src/main/login.ts"), () => ({
  openLoginManager: () => ({
    manager: { status: () => loginStatus, setEnabled: () => loginStatus },
    close() {},
  }),
}));
const supportModule = await import("../../src/main/updater/support");
mock.module(resolve("src/main/updater/support.ts"), () => ({
  ...supportModule,
  readUpdateSupport: async () => ({ supported: false, installedVersion: null }),
}));
let before: unknown;
let initialized = false;
try {
  await import("../../src/main/index");
  initialized = true;
  if (action === "native") quit();
  else if (action === "menu")
    handlers.get("application-menu-clicked")?.({ data: { action: "quit" } });
  else
    for (const listener of process.listeners("SIGTERM")) {
      if (!initialSignals.has(listener)) Reflect.apply(listener, process, ["SIGTERM"]);
    }
  await Bun.sleep(75);
  before = { action, cleanupStarted, rendererDecisions };
} finally {
  // Noninteractive cleanup must remain usable even when the simulated renderer declines Quit.
  for (const listener of process.listeners("SIGTERM")) {
    if (!initialSignals.has(listener)) Reflect.apply(listener, process, ["SIGTERM"]);
  }
  if (initialized) await eventually(() => cleanupStarted > 0);
  await originalClose();
  for (const timer of timers) clearInterval(timer);
  intervalSpy.mockRestore();
  await context.cleanup();
}
console.log(JSON.stringify(before));
