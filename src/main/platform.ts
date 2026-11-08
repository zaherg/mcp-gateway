import { isAbsolute, join } from "node:path";

function absolutePath(path: string, name: string): string {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error(`${name} must be an absolute path.`);
  return path;
}

export function configurationDirectory(configBase: string): string {
  return join(absolutePath(configBase, "Configuration base"), "MCP Gateway");
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
