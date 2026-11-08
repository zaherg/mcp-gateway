import { Electroview } from "electrobun/view";
import type { AppClient, AppRPC } from "../shared/rpc";

// One native bridge for the lifetime of the renderer. No HTTP administration API.
const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      interactiveQuit: () =>
        !window.dispatchEvent(new Event("mcp-gateway:request-quit", { cancelable: true })),
    },
    messages: {},
  },
});
export const electroview = new Electroview({ rpc });
export const client: AppClient = {
  readLogs: (params) => rpc.request.readLogs(params),
  clearLogs: () => rpc.request.clearLogs(),
  snapshot: () => rpc.request.snapshot(),
  quit: () => rpc.request.quit(),
  quitStatus: () => rpc.request.quitStatus(),
  start: () => rpc.request.start(),
  stop: () => rpc.request.stop(),
  restartServer: (params) => rpc.request.restartServer(params),
  saveConfig: (params) => rpc.request.saveConfig(params),
  copyEndpoint: (params) => rpc.request.copyEndpoint(params),
  copyClientConfig: (params) => rpc.request.copyClientConfig(params),
  updatesStatus: () => rpc.request.updatesStatus(),
  updatesCheck: () => rpc.request.updatesCheck(),
  updatesDownload: () => rpc.request.updatesDownload(),
  updatesSetAutomatic: (params) => rpc.request.updatesSetAutomatic(params),
  updatesRestart: (params) => rpc.request.updatesRestart(params),
};
