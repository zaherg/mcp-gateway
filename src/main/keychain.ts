import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { failure } from '@mcp-gateway/core/errors';
import { type NativeKeychain, openNativeKeychain } from '@mcp-gateway/main/native';
import { TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import type { KeyStore } from '@mcp-gateway/shared/types';

const DEADLINE_MS = 5_000;
const UNREADABLE =
  'A Keychain key could not be read. Unlock Keychain and start the gateway, or generate a new key.';
const UNWRITABLE = 'A key could not be stored in Keychain.';

// A locked Keychain can wait on a system prompt; the app stops waiting but the prompt may remain.
const withDeadline = <A>(work: () => Promise<A>, error: () => Error) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(error()), DEADLINE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

const defaultNativeLibraryPath = () => {
  const candidates = [
    resolve(import.meta.dir, '../../.cache/native/login.dylib'),
    resolve(import.meta.dir, '../native/login.dylib'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
};

/**
 * In-process Keychain access via Security.framework FFI when login.dylib is available,
 * falling back to Bun.secrets only when no compiled dylib is present.
 * Errors are fixed text: never the key, the ID or the system message.
 */
export const openKeychain = (identifier: string, libraryPath?: string): KeyStore => {
  const service = identifier === TEST_IDENTIFIER ? 'MCP Gateway APP Test' : 'MCP Gateway APP';
  const unreadable = () => failure('KeyUnavailable', UNREADABLE);
  const unwritable = () => failure('ConfigIO', UNWRITABLE);
  const resolvedLibrary = libraryPath ?? defaultNativeLibraryPath();
  let native: NativeKeychain | undefined;
  if (resolvedLibrary && existsSync(resolvedLibrary)) {
    try {
      native = openNativeKeychain(resolvedLibrary);
    } catch {
      native = undefined;
    }
  }
  return {
    get: (refs) =>
      withDeadline(async () => {
        const keys = new Map<string, string>();
        for (const ref of refs) {
          const value = native
            ? native.get(service, ref)
            : await Bun.secrets.get({ service, name: ref }).catch(() => null);
          if (!value) throw unreadable();
          keys.set(ref, value);
        }
        return keys;
      }, unreadable),
    set: (ref, value) => {
      // Bun.secrets.set with an empty value deletes the item; the app never deletes one.
      if (!value) return Promise.reject(unwritable());
      return withDeadline(async () => {
        if (native) {
          if (!native.set(service, ref, value)) throw unwritable();
          return;
        }
        await Bun.secrets.set({ service, name: ref, value }).catch(() => {
          throw unwritable();
        });
      }, unwritable);
    },
  };
};
