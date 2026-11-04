import { dlopen, FFIType } from "bun:ffi";
import type { DesktopPlatform, LoginStatus } from "../shared/rpc";
import type { LoginManager } from "./service";

export interface LoginNative {
  status(): number;
  set(enabled: boolean): number;
}

export class MacLoginManager implements LoginManager {
  private occurrence = 0;
  private lastStatusError: string | null = null;
  private operationError: string | null = null;
  private requestedState: 0 | 1 | undefined;
  constructor(
    private readonly native: LoginNative,
    private readonly allowChanges = true,
  ) {}

  status(): LoginStatus {
    const status = this.native.status();
    // Pending approval is disabled, but is not a completed unregister operation.
    if (status === this.requestedState) this.operationError = null;
    const result: LoginStatus = {
      enabled: status === 1,
      supported: status >= 0 && this.allowChanges,
      error:
        this.operationError ??
        (!this.allowChanges
          ? "Login registration is disabled in isolated verification."
          : status === -1
            ? "Login startup requires the signed release on macOS 13 or newer."
            : status === 2
              ? "Approve MCP Gateway under System Settings > General > Login Items."
              : status === 3
                ? "macOS could not locate this app for login startup."
                : null),
    };
    if (result.error !== this.lastStatusError) this.occurrence++;
    this.lastStatusError = result.error;
    if (result.error) result.occurrenceId = `login-${this.occurrence}`;
    return result;
  }

  setEnabled(enabled: boolean): LoginStatus {
    this.occurrence++;
    this.operationError = null;
    if (!this.status().supported) {
      this.operationError =
        "Configuration saved, but login registration is unavailable in this build.";
      return this.status();
    }
    this.requestedState = enabled ? 1 : 0;
    if (this.native.set(enabled) !== 0) {
      this.operationError =
        "Configuration saved, but macOS refused the login change. Check System Settings > General > Login Items, then save again.";
    } else if (this.native.status() !== (enabled ? 1 : 0)) {
      this.operationError =
        "Configuration saved; macOS login status does not yet match. Check approval in System Settings > General > Login Items.";
    }
    return this.status();
  }
}

function closedError(): never {
  throw new Error("closed");
}

export function openLoginManager(platform: DesktopPlatform, path: string, allowChanges: boolean) {
  if (platform === "linux") {
    const status = (): LoginStatus => ({
      enabled: false,
      supported: false,
      error: "Automatic login registration is unavailable on Linux.",
    });
    return {
      manager: { status, setEnabled: (_enabled: boolean) => status() } satisfies LoginManager,
      statusCode: () => null,
      requestCloseShortcut: () => {
        throw new Error("Cocoa shortcuts are unavailable on Linux.");
      },
      requestQuitShortcut: () => {
        throw new Error("Cocoa shortcuts are unavailable on Linux.");
      },
      close: () => {},
    };
  }
  const library = dlopen(path, {
    mcp_login_status: { args: [], returns: FFIType.i32 },
    mcp_login_set: { args: [FFIType.i32], returns: FFIType.i32 },
    mcp_test_close_shortcut: { args: [], returns: FFIType.void },
    mcp_test_quit_shortcut: { args: [], returns: FFIType.void },
  });
  let closed = false;
  let cachedStatus: number | undefined;
  const native: LoginNative = {
    status: () => {
      if (closed) return cachedStatus ?? -1;
      const status = library.symbols.mcp_login_status();
      cachedStatus = status;
      return status;
    },
    set: (enabled) => {
      if (closed) closedError();
      return library.symbols.mcp_login_set(enabled ? 1 : 0);
    },
  };
  const manager = new MacLoginManager(native, allowChanges);
  return {
    manager,
    statusCode: () => (closed ? closedError() : library.symbols.mcp_login_status()),
    requestCloseShortcut: () =>
      closed ? closedError() : library.symbols.mcp_test_close_shortcut(),
    requestQuitShortcut: () => (closed ? closedError() : library.symbols.mcp_test_quit_shortcut()),
    close: () => {
      if (closed) return;
      closed = true;
      library.close();
    },
  };
}
