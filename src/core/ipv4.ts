/** An IPv4 network as unsigned 32-bit integers; `network` has no host bits set. */
export interface Ipv4Range {
  network: number;
  mask: number;
}

const OCTET = /^(0|[1-9][0-9]{0,2})$/;

/** A strict dotted-quad IPv4 address as an unsigned integer, or null. */
export const ipv4Number = (text: string): number | null => {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part) || Number(part) > 255) return null;
    value = (value * 256 + Number(part)) >>> 0;
  }
  return value;
};

/** A strict `a.b.c.d/n` network whose address has no host bits set, or null. */
export const parseIpv4Range = (text: string): Ipv4Range | null => {
  const match = /^([0-9.]+)\/(0|[1-9][0-9]?)$/.exec(text);
  if (!match) return null;
  const address = ipv4Number(match[1] ?? '');
  const bits = Number(match[2]);
  if (address === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === address ? { network: address, mask } : null;
};

export const inIpv4Range = (address: number, range: Ipv4Range): boolean =>
  (address & range.mask) >>> 0 === range.network;

const knownRange = (text: string): Ipv4Range => {
  const range = parseIpv4Range(text);
  if (!range) throw new Error(`Invalid built-in IPv4 range ${text}`);
  return range;
};

/** Shared address space (RFC 6598): Tailscale assigns it, and so does carrier-grade NAT. */
const SHARED_RANGE = knownRange('100.64.0.0/10');

export const isSharedIpv4 = (address: number): boolean => inIpv4Range(address, SHARED_RANGE);

/** Private-use space (RFC 1918) and shared space. Listener addresses and allowed peers stay inside these. */
export const LOCAL_RANGES: readonly Ipv4Range[] = [
  ...['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(knownRange),
  SHARED_RANGE,
];

export const isLocalIpv4 = (address: number): boolean =>
  LOCAL_RANGES.some((range) => inIpv4Range(address, range));

/** True when every address in `range` is inside one local range. */
export const isLocalRange = (range: Ipv4Range): boolean =>
  LOCAL_RANGES.some((local) => range.mask >= local.mask && inIpv4Range(range.network, local));
