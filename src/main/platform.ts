import { isAbsolute, join } from "node:path";

function absolutePath(path: string, name: string): string {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error(`${name} must be an absolute path.`);
  return path;
}

export function configurationDirectory(
  home: string,
  environment: NodeJS.ProcessEnv,
  configBase?: string,
): string {
  if (environment.MCP_GATEWAY_DATA_DIR !== undefined)
    return absolutePath(environment.MCP_GATEWAY_DATA_DIR, "MCP_GATEWAY_DATA_DIR");
  if (configBase !== undefined)
    return join(absolutePath(configBase, "Configuration base"), "MCP Gateway");
  absolutePath(home, "Home directory");
  return join(home, "Library/Application Support/MCP Gateway");
}

export function startsInBackground(
  requested: boolean,
  login: { supported: boolean; enabled: boolean },
  savedLoginPreference: boolean,
): boolean {
  return requested || login.enabled || savedLoginPreference;
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
