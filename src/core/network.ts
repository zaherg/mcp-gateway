import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

import { isHttpServer } from '@mcp-gateway/core/config';
import { failure, GatewayError } from '@mcp-gateway/core/errors';
import type { GatewayConfig, InterfaceChoice } from '@mcp-gateway/shared/types';

const ipv4 = (value: string): string | null => {
  if (isIP(value) === 4) return value;
  if (/^::ffff:/i.test(value)) {
    const suffix = value.slice(7);
    if (isIP(suffix) === 4) return suffix;
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(suffix)) {
      const [high, low] = suffix.split(':').map((part) => Number.parseInt(part, 16));
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  return null;
};
const numeric = (address: string) =>
  address.split('.').reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
const isLoopback = (address: string) => ipv4(address)?.startsWith('127.') === true;
const isPrivate = (address: string): boolean => {
  const ip = ipv4(address);
  if (!ip) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

export const interfaceChoices = (): InterfaceChoice[] => {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter(
        (entry) =>
          entry.family === 'IPv4' && (isPrivate(entry.address) || isLoopback(entry.address)),
      )
      .map((entry) => ({
        name,
        address: entry.address,
        netmask: entry.netmask,
        loopback: isLoopback(entry.address),
      })),
  );
};

export const selectInterface = (host: string): InterfaceChoice => {
  const choice = interfaceChoices().find((entry) => entry.address === host);
  if (!choice)
    throw failure('NetworkPolicy', 'Select a currently assigned private IPv4 or loopback address.');
  return choice;
};

export const peerAllowed = (peer: string, selected: InterfaceChoice): boolean => {
  const ip = ipv4(peer);
  if (!ip) return false;
  if (isLoopback(ip)) return true;
  // A broad local netmask must not admit public addresses or other networks.
  if (selected.loopback || !isPrivate(ip)) return false;
  const mask = numeric(selected.netmask);
  return (numeric(ip) & mask) === (numeric(selected.address) & mask);
};

/** One budget for every self-proxy hostname lookup an operation performs. */
export const SELF_PROXY_DEADLINE_MS = 5_000;

export interface SelfProxyOptions {
  /** Stops the application's wait; a lookup already in flight is left unobserved. */
  signal?: AbortSignal;
  /** Absolute epoch-millisecond deadline shared by an operation's validation passes. */
  deadline?: number;
}

export const isSelfProxyCancelled = (error: unknown): boolean =>
  error instanceof GatewayError && error.code === 'Cancelled';

const cancelled = () =>
  failure('Cancelled', 'The self-proxy check was cancelled because the gateway is stopping.');
const timedOut = () =>
  failure('NetworkPolicy', 'An upstream address could not be checked before the deadline.');
const unchecked = () =>
  failure('NetworkPolicy', 'An upstream hostname could not be checked for self-proxy recursion.');

type LookupOutcome =
  | { kind: 'resolved'; addresses: readonly { address: string }[] }
  | { kind: 'failed' }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

// DNS lookup itself cannot be cancelled. This bounds the wait, removes its
// timer and listener when it ends either way, and observes later settlement so
// a late answer cannot resolve or reject an invocation that already refused.
const boundedLookup = (
  work: Promise<readonly { address: string }[]>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<LookupOutcome> => {
  return new Promise((settle) => {
    let finished = false;
    const finish = (outcome: LookupOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(outcome);
    };
    const abort = () => finish({ kind: 'cancelled' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    // Observe settlement even when the wait is already cancelled, so a rejected
    // resolver cannot become an unhandled rejection.
    work.then(
      (addresses) => finish({ kind: 'resolved', addresses }),
      () => finish({ kind: 'failed' }),
    );
    if (signal?.aborted) {
      finish({ kind: 'cancelled' });
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
};

export const rejectSelfProxy = async (
  config: GatewayConfig,
  options: SelfProxyOptions = {},
): Promise<void> => {
  const deadline = options.deadline ?? Date.now() + SELF_PROXY_DEADLINE_MS;
  // A superseded or already-expired operation refuses even when a stdio-only,
  // disabled or different-port configuration needs no hostname lookup.
  if (options.signal?.aborted) throw cancelled();
  if (Date.now() >= deadline) throw timedOut();
  const hostnames: string[] = [];
  for (const server of Object.values(config.mcpServers)) {
    if (server.disabled || !isHttpServer(server)) continue;
    const url = URL.parse(server.url);
    if (!url) throw unchecked();
    if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== config.gateway.port)
      continue;
    hostnames.push(url.hostname.replace(/^\[|\]$/g, ''));
  }
  for (const hostname of hostnames) {
    const remaining = deadline - Date.now();
    if (options.signal?.aborted) throw cancelled();
    if (remaining <= 0) throw timedOut();
    let work: Promise<readonly { address: string }[]>;
    try {
      work = lookup(hostname, { all: true });
    } catch {
      throw unchecked();
    }
    const outcome = await boundedLookup(work, options.signal, remaining);
    // Recheck after the wait: the signal may have been cancelled or the shared
    // deadline may have passed while the lookup was settling.
    if (options.signal?.aborted) throw cancelled();
    if (Date.now() >= deadline) throw timedOut();
    if (outcome.kind === 'cancelled') throw cancelled();
    if (outcome.kind === 'timeout') throw timedOut();
    if (outcome.kind === 'failed') throw unchecked();
    const addresses = outcome.addresses.map((entry) => entry.address);
    if (addresses.length === 0) throw unchecked();
    if (
      addresses.some(
        (address) =>
          address === '::' || ipv4(address) === '0.0.0.0' || ipv4(address) === config.gateway.host,
      )
    )
      throw failure('NetworkPolicy', 'An upstream must not point back to this gateway listener.');
  }
};
