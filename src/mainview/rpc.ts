import { Electroview } from 'electrobun/view';

import type { AppClient, AppRPC, AppSnapshot, MenuCommand } from '@mcp-gateway/shared/rpc';

let checkUnsavedRawConfig = () => false;
const snapshotListeners = new Set<(snapshot: AppSnapshot) => void>();
const menuCommandListeners = new Set<(command: MenuCommand) => void>();

export const setUnsavedRawConfigChecker = (checker: () => boolean) => {
  checkUnsavedRawConfig = checker;
};

export const onSnapshotChanged = (listener: (snapshot: AppSnapshot) => void) => {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
};

export const onMenuCommand = (listener: (command: MenuCommand) => void) => {
  menuCommandListeners.add(listener);
  return () => menuCommandListeners.delete(listener);
};

// One native bridge for the lifetime of the renderer. No HTTP administration API.
const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      hasUnsavedRawConfig: () => checkUnsavedRawConfig(),
    },
    messages: {
      snapshotChanged: (snapshot) => {
        for (const listener of snapshotListeners) listener(snapshot);
      },
      menuCommand: ({ command }) => {
        for (const listener of menuCommandListeners) listener(command);
      },
    },
  },
});
new Electroview({ rpc });

const scrubElectrobunWindowSecrets = () => {
  const globalWindow = window as unknown as Record<string, unknown>;
  const rawKeyBytes = globalWindow.__electrobunSecretKeyBytes;
  if (Array.isArray(rawKeyBytes)) {
    queueMicrotask(() => {
      rawKeyBytes.fill(0);
    });
  } else if (rawKeyBytes instanceof Uint8Array) {
    queueMicrotask(() => {
      rawKeyBytes.fill(0);
    });
  }
  Reflect.deleteProperty(window, '__electrobunSecretKeyBytes');
  Reflect.deleteProperty(window, '__electrobunRpcSocketPort');
};
scrubElectrobunWindowSecrets();

export const client: AppClient = Object.assign(rpc.request, {
  onSnapshotChanged,
  onMenuCommand,
});
