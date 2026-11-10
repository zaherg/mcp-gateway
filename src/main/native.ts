import { dlopen, FFIType, type Pointer } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { LoginManager } from '@mcp-gateway/main/service';
import { PRODUCTION_IDENTIFIER, TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import type { LoginStatus } from '@mcp-gateway/shared/rpc';

interface LoginNative {
  status(): number;
  set(enabled: boolean): number;
}

class MacLoginManager implements LoginManager {
  private occurrence = 0;
  private lastStatusError: string | null = null;
  private operationError: string | null = null;
  private requestedState: 0 | 1 | undefined;
  constructor(private readonly native: LoginNative) {}

  status(): LoginStatus {
    const status = this.native.status();
    // Pending approval is disabled, but is not a completed unregister operation.
    if (status === this.requestedState) this.operationError = null;
    const result: LoginStatus = {
      enabled: status === 1,
      supported: status >= 0,
      error:
        this.operationError ??
        (status === -1
          ? 'Login startup requires the signed release on macOS 13 or newer.'
          : status === 2
            ? 'Approve MCP Gateway under System Settings > General > Login Items.'
            : status === 3
              ? 'macOS could not locate this app for login startup.'
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
        'Configuration saved, but login registration is unavailable in this build.';
      return this.status();
    }
    this.requestedState = enabled ? 1 : 0;
    if (this.native.set(enabled) !== 0) {
      this.operationError =
        'Configuration saved, but macOS refused the login change. Check System Settings > General > Login Items, then save again.';
    } else if (this.native.status() !== (enabled ? 1 : 0)) {
      this.operationError =
        'Configuration saved; macOS login status does not yet match. Check approval in System Settings > General > Login Items.';
    }
    return this.status();
  }
}

export const openLoginManager = (path: string) => {
  const library = dlopen(path, {
    mcp_login_status: { args: [], returns: FFIType.i32 },
    mcp_login_set: { args: [FFIType.i32], returns: FFIType.i32 },
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
      if (closed) throw new Error('closed');
      return library.symbols.mcp_login_set(enabled ? 1 : 0);
    },
  };
  const manager = new MacLoginManager(native);
  return {
    manager,
    close: () => {
      if (closed) return;
      closed = true;
      library.close();
    },
  };
};

export const observeNativeQuitSignals = (path: string): (() => boolean) => {
  const library = dlopen(path, {
    mcp_quit_signal_install: { args: [], returns: FFIType.i32 },
    mcp_quit_signal_requested: { args: [], returns: FFIType.i32 },
  });
  // This separate reference lives until process exit: signal handlers must remain
  // mapped even after the login owner closes its own reference during cleanup.
  if (library.symbols.mcp_quit_signal_install() !== 0)
    throw new Error('Native Quit signal observation could not be installed.');
  return () => library.symbols.mcp_quit_signal_requested() !== 0;
};

interface NativeWindowHandle {
  ptr: Pointer | null;
}

export type MinimumWindowSize = (window: NativeWindowHandle, width: number, height: number) => void;

// Electrobun has no minimum-size option, so the NSWindow minimum is set natively.
export const openMinimumWindowSize = (path: string): MinimumWindowSize => {
  const library = dlopen(path, {
    mcp_window_set_min_content_size: {
      args: [FFIType.ptr, FFIType.f64, FFIType.f64],
      returns: FFIType.i32,
    },
  });
  return (window, width, height) => {
    const pointer = window.ptr;
    if (!pointer) throw new Error('The window no longer exists.');
    const status = library.symbols.mcp_window_set_min_content_size(pointer, width, height);
    if (status !== 0) throw new Error(`The native window minimum size was refused (${status}).`);
  };
};

// The glyph is redrawn natively because the template flag cannot carry the dot's color.
export const openTrayIndicator = (
  glyphPath: string,
  size: number,
  libraryPath: string,
): ((running: boolean) => void) => {
  const library = dlopen(libraryPath, {
    mcp_tray_set_running: {
      args: [FFIType.cstring, FFIType.f64, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  const path = Buffer.from(`${glyphPath}\0`);
  return (running) => {
    const status = library.symbols.mcp_tray_set_running(path, size, running ? 1 : 0);
    if (status !== 0) throw new Error(`The tray indicator could not be updated (${status}).`);
  };
};

type AppIdentifier = typeof PRODUCTION_IDENTIFIER | typeof TEST_IDENTIFIER;

export const installedIdentifier = (resourcesFolder: string): AppIdentifier => {
  let identifier: unknown;
  try {
    identifier = JSON.parse(readFileSync(join(resourcesFolder, 'version.json'), 'utf8')).identifier;
  } catch (error) {
    throw new Error("The app's version.json is missing or invalid.", { cause: error });
  }
  if (identifier !== PRODUCTION_IDENTIFIER && identifier !== TEST_IDENTIFIER)
    throw new Error('Unsupported app identifier in version.json.');
  return identifier;
};

// Utils.paths.config does not include the bundle identifier, so test builds need
// their own folder to stay off the production configuration.
export const configurationDirectory = (configBase: string, identifier: AppIdentifier): string => {
  if (!isAbsolute(configBase) || configBase.includes('\0'))
    throw new Error('Configuration base must be an absolute path.');
  return join(configBase, identifier === TEST_IDENTIFIER ? 'MCP Gateway Test' : 'MCP Gateway');
};

interface RestorableWindow {
  unminimize(): void;
  show(): void;
  activate(): void;
}

export const restoreWindow = (window: RestorableWindow): void => {
  window.unminimize();
  window.show();
  window.activate();
};
