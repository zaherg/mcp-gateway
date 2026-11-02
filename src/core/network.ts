import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { GatewayConfig, InterfaceChoice } from "../shared/types";
import { isHttpServer } from "./config";
import { failure } from "./errors";

export function ipv4(value: string): string | null {
  if (isIP(value) === 4) return value;
  if (/^::ffff:/i.test(value)) {
    const suffix = value.slice(7);
    if (isIP(suffix) === 4) return suffix;
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(suffix)) {
      const [high, low] = suffix.split(":").map((part) => Number.parseInt(part, 16));
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  return null;
}
const numeric = (address: string) =>
  address.split(".").reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
export const isLoopback = (address: string) => ipv4(address)?.startsWith("127.") === true;
export function isPrivate(address: string): boolean {
  const ip = ipv4(address);
  if (!ip) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function interfaceChoices(): InterfaceChoice[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter(
        (entry) =>
          entry.family === "IPv4" && (isPrivate(entry.address) || isLoopback(entry.address)),
      )
      .map((entry) => ({
        name,
        address: entry.address,
        netmask: entry.netmask,
        loopback: isLoopback(entry.address),
      })),
  );
}

export function selectInterface(host: string): InterfaceChoice {
  const choice = interfaceChoices().find((entry) => entry.address === host);
  if (!choice)
    throw failure("NetworkPolicy", "Select a currently assigned private IPv4 or loopback address.");
  return choice;
}

export function peerAllowed(peer: string, selected: InterfaceChoice): boolean {
  const ip = ipv4(peer);
  if (!ip) return false;
  if (isLoopback(ip)) return true;
  // A broad local netmask must not admit public addresses or other networks.
  if (selected.loopback || !isPrivate(ip)) return false;
  const mask = numeric(selected.netmask);
  return (numeric(ip) & mask) === (numeric(selected.address) & mask);
}

export async function rejectSelfProxy(
  config: GatewayConfig,
  resolve: (
    hostname: string,
    options: { all: true },
  ) => Promise<readonly { address: string }[]> = lookup,
): Promise<void> {
  for (const server of Object.values(config.mcpServers)) {
    if (server.disabled || !isHttpServer(server)) continue;
    const url = new URL(server.url);
    if (Number(url.port || (url.protocol === "https:" ? 443 : 80)) !== config.gateway.port)
      continue;
    let addresses: string[];
    try {
      addresses = (await resolve(url.hostname.replace(/^\[|\]$/g, ""), { all: true })).map(
        (entry) => entry.address,
      );
      if (addresses.length === 0) throw new Error("No upstream addresses resolved");
    } catch {
      throw failure(
        "NetworkPolicy",
        "An upstream hostname could not be checked for self-proxy recursion.",
      );
    }
    if (
      addresses.some(
        (address) =>
          address === "::" || ipv4(address) === "0.0.0.0" || ipv4(address) === config.gateway.host,
      )
    )
      throw failure("NetworkPolicy", "An upstream must not point back to this gateway listener.");
  }
}
