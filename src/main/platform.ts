import { isAbsolute, join } from "node:path";
import type { DesktopPlatform } from "../shared/rpc";

export function desktopPlatform(platform: string): DesktopPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  throw new Error("Desktop runtime is supported only on macOS and Linux.");
}

function absolutePath(path: string, name: string): string {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error(`${name} must be an absolute path.`);
  return path;
}

export function configurationDirectory(
  platform: DesktopPlatform,
  home: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (environment.MCP_GATEWAY_DATA_DIR !== undefined)
    return absolutePath(environment.MCP_GATEWAY_DATA_DIR, "MCP_GATEWAY_DATA_DIR");
  if (environment.MCP_GATEWAY_ISOLATED === "1")
    throw new Error("Isolated verification requires an explicit data directory.");
  absolutePath(home, "Home directory");
  return platform === "macos"
    ? join(home, "Library/Application Support/MCP Gateway")
    : join(
        environment.XDG_CONFIG_HOME === undefined
          ? join(home, ".config")
          : absolutePath(environment.XDG_CONFIG_HOME, "XDG_CONFIG_HOME"),
        "MCP Gateway",
      );
}

export function startsInBackground(
  platform: DesktopPlatform,
  requested: boolean,
  login: { supported: boolean; enabled: boolean },
  savedLoginPreference: boolean,
): boolean {
  // Linux has no native reopen action and must remain reachable without a tray host.
  return platform === "macos" && (requested || login.enabled || savedLoginPreference);
}

export function handleWindowClose(
  platform: DesktopPlatform,
  event: unknown,
  window: { minimize(): void },
): void {
  if (platform !== "linux") return;
  if (typeof event !== "object" || event === null) throw new Error("Invalid native close event.");
  Object.assign(event, { response: { allow: false } });
  window.minimize();
}

export function restoreWindow(window: {
  unminimize(): void;
  show(): void;
  activate(): void;
}): void {
  window.unminimize();
  window.show();
  window.activate();
}
