import { Electroview } from "electrobun/view";
import type { AppClient, AppRPC } from "../shared/rpc";

// One native bridge for the lifetime of the renderer. No HTTP administration API.
const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      smokeQuit: () => {
        const button = document.querySelector<HTMLButtonElement>('button[data-action="quit"]');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      },
      viewportPolicy: () => ({
        supported: CSS.supports("overscroll-behavior", "none"),
        documentOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
        bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
      }),
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
};
