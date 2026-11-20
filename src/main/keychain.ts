import { failure } from '@mcp-gateway/core/errors';
import { TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import type { KeyStore } from '@mcp-gateway/shared/types';

const DEADLINE_MS = 5_000;
const UNREADABLE =
  'A Keychain key could not be read. Unlock Keychain and start the gateway, or generate a new key.';
const UNWRITABLE = 'A key could not be stored in Keychain.';

// A locked Keychain can wait on a system prompt; the app stops waiting but the prompt may remain.
const withDeadline = <A>(work: () => Promise<A>, error: () => Error): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(error()), DEADLINE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The only use of Bun.secrets. The service is fixed by the installed identifier and the
 * account is the reference ID. Errors are fixed text: never the key, the ID or the system message.
 */
export const openKeychain = (identifier: string): KeyStore => {
  const service = identifier === TEST_IDENTIFIER ? 'MCP Gateway Test' : 'MCP Gateway';
  const unreadable = () => failure('KeyUnavailable', UNREADABLE);
  const unwritable = () => failure('ConfigIO', UNWRITABLE);
  return {
    get: (refs) =>
      withDeadline(async () => {
        const keys = new Map<string, string>();
        for (const ref of refs) {
          const value = await Bun.secrets.get({ service, name: ref }).catch(() => null);
          if (!value) throw unreadable();
          keys.set(ref, value);
        }
        return keys;
      }, unreadable),
    set: (ref, value) => {
      // Bun.secrets.set with an empty value deletes the item; the app never deletes one.
      if (!value) return Promise.reject(unwritable());
      return withDeadline(
        () =>
          Bun.secrets.set({ service, name: ref, value }).catch(() => {
            throw unwritable();
          }),
        unwritable,
      );
    },
  };
};
