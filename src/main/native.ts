import { dlopen, FFIType, type Pointer, ptr } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { LoginManager } from '@mcp-gateway/main/service';
import { PRODUCTION_IDENTIFIER, TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import type { LoginStatus } from '@mcp-gateway/shared/rpc';

export interface NativeKeychain {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): boolean;
  delete(service: string, account: string): boolean;
  close(): void;
}

const KEYCHAIN_BUFFER_BYTES = 16 * 1024;
const cstring = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf8');

const NATIVE_SYMBOLS = {
  mcp_keychain_get: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  mcp_keychain_set: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  mcp_keychain_delete: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  mcp_login_status: { args: [], returns: FFIType.i32 },
  mcp_login_set: { args: [FFIType.i32], returns: FFIType.i32 },
  mcp_begin_idle_sleep_assertion: { args: [], returns: FFIType.ptr },
  mcp_end_idle_sleep_assertion: { args: [FFIType.ptr], returns: FFIType.void },
  mcp_quit_signal_install: { args: [], returns: FFIType.i32 },
  mcp_quit_signal_requested: { args: [], returns: FFIType.i32 },
  mcp_window_set_min_content_size: {
    args: [FFIType.ptr, FFIType.f64, FFIType.f64],
    returns: FFIType.i32,
  },
  mcp_tray_set_running: {
    args: [FFIType.cstring, FFIType.f64, FFIType.i32],
    returns: FFIType.i32,
  },
  mcp_preferred_languages: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  mcp_post_notification: {
    args: [FFIType.cstring, FFIType.cstring],
    returns: FFIType.i32,
  },
} as const;

type NativeLibrary = ReturnType<typeof dlopen<typeof NATIVE_SYMBOLS>>;

const nativeLibraries = new Map<string, NativeLibrary>();

// Shared process-lifetime FFI handle: signal handlers and AppKit observers remain mapped until exit.
const getNativeLibrary = (path: string): NativeLibrary => {
  const key = resolve(path);
  const existing = nativeLibraries.get(key);
  if (existing) return existing;
  const opened = dlopen(key, NATIVE_SYMBOLS);
  nativeLibraries.set(key, opened);
  return opened;
};

export const postNativeNotification = (
  title: string,
  body: string,
  libraryPath?: string,
  onError?: (error: unknown) => void,
): void => {
  try {
    const library = libraryPath
      ? getNativeLibrary(libraryPath)
      : nativeLibraries.values().next().value;
    if (!library) return;
    const cleanTitle = title.replace(/\0/g, '');
    const cleanBody = body.replace(/\0/g, '');
    if (!cleanTitle && !cleanBody) return;
    const titleBuf = cstring(cleanTitle);
    const bodyBuf = cstring(cleanBody);
    library.symbols.mcp_post_notification(titleBuf, bodyBuf);
  } catch (error) {
    onError?.(error);
  }
};

export const openNotificationSender = (
  libraryPath: string,
  onError?: (error: unknown) => void,
): ((title: string, body: string) => void) => {
  getNativeLibrary(libraryPath);
  return (title, body) => {
    postNativeNotification(title, body, libraryPath, onError);
  };
};

export const openNativeKeychain = (libraryPath: string): NativeKeychain => {
  const library = getNativeLibrary(libraryPath);
  return {
    get: (service, account) => {
      if (service.includes('\0') || account.includes('\0')) return null;
      const serviceBuf = cstring(service);
      const accountBuf = cstring(account);
      const buffer = Buffer.alloc(KEYCHAIN_BUFFER_BYTES);
      const length = library.symbols.mcp_keychain_get(
        ptr(serviceBuf),
        ptr(accountBuf),
        ptr(buffer),
        buffer.length,
      );
      if (length < 0) return null;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      } catch {
        return null;
      }
    },
    set: (service, account, value) => {
      if (!value || service.includes('\0') || account.includes('\0')) return false;
      const serviceBuf = cstring(service);
      const accountBuf = cstring(account);
      const valueBuf = Buffer.from(value, 'utf8');
      return (
        library.symbols.mcp_keychain_set(
          ptr(serviceBuf),
          ptr(accountBuf),
          ptr(valueBuf),
          valueBuf.length,
        ) === 0
      );
    },
    delete: (service, account) => {
      if (service.includes('\0') || account.includes('\0')) return false;
      const serviceBuf = cstring(service);
      const accountBuf = cstring(account);
      return library.symbols.mcp_keychain_delete(ptr(serviceBuf), ptr(accountBuf)) === 0;
    },
    close: () => {},
  };
};

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
      if (enabled)
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
  const library = getNativeLibrary(path);
  const native: LoginNative = {
    status: () => library.symbols.mcp_login_status(),
    set: (enabled) => library.symbols.mcp_login_set(enabled ? 1 : 0),
  };
  const manager = new MacLoginManager(native);
  return {
    manager,
    close: () => {},
  };
};

export const preventIdleSleep = (path: string): (() => void) => {
  const library = getNativeLibrary(path);
  const activity = library.symbols.mcp_begin_idle_sleep_assertion();
  if (!activity) {
    throw new Error('macOS did not grant the idle sleep assertion.');
  }
  return () => {
    library.symbols.mcp_end_idle_sleep_assertion(activity);
  };
};

export const observeNativeQuitSignals = (path: string): (() => boolean) => {
  const library = getNativeLibrary(path);
  if (library.symbols.mcp_quit_signal_install() !== 0)
    throw new Error('Native Quit signal observation could not be installed.');
  return () => library.symbols.mcp_quit_signal_requested() !== 0;
};

interface NativeWindowHandle {
  ptr: Pointer | null;
}

type MinimumWindowSize = (window: NativeWindowHandle, width: number, height: number) => void;

// Electrobun has no minimum-size option, so the NSWindow minimum is set natively.
export const openMinimumWindowSize = (path: string): MinimumWindowSize => {
  const library = getNativeLibrary(path);
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
  const library = getNativeLibrary(libraryPath);
  const path = Buffer.from(`${glyphPath}\0`);
  return (running) => {
    const status = library.symbols.mcp_tray_set_running(path, size, running ? 1 : 0);
    if (status !== 0) throw new Error(`The tray indicator could not be updated (${status}).`);
  };
};

// Bun's Intl follows LANG, which a Finder or login-item launch does not set; AppKit has the list.
export const readPreferredLanguages = (path: string): string[] => {
  const library = getNativeLibrary(path);
  const buffer = Buffer.alloc(4096);
  const length = library.symbols.mcp_preferred_languages(ptr(buffer), buffer.length);
  if (length < 0) throw new Error(`The preferred languages could not be read (${length}).`);
  return buffer.toString('utf8', 0, length).split('\n').filter(Boolean);
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
