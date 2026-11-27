import { describe, expect, test } from 'bun:test';

import { failure, GatewayError } from '@mcp-gateway/core/errors';
import {
  inIpv4Range,
  ipv4Number,
  isLinkLocalIpv4,
  isLocalIpv4,
  isLocalRange,
  isSharedIpv4,
  parseIpv4Range,
} from '@mcp-gateway/core/ipv4';
import {
  compileAllowedPeers,
  interfaceChoices,
  isSelfProxyCancelled,
  peerAllowed,
  rejectSelfProxy,
  selectInterface,
  validateHostHeader,
  validateOriginHeader,
} from '@mcp-gateway/core/network';
import type { GatewayConfig, InterfaceChoice } from '@mcp-gateway/shared/types';

const mustIp = (text: string): number => {
  const value = ipv4Number(text);
  if (value === null) throw new Error(`Expected valid IPv4 address: ${text}`);
  return value;
};

const mustRange = (text: string) => {
  const range = parseIpv4Range(text);
  if (!range) throw new Error(`Expected valid IPv4 range: ${text}`);
  return range;
};

const makeConfig = (
  overrides: Partial<GatewayConfig['gateway']>,
  mcpServers: GatewayConfig['mcpServers'] = {},
): GatewayConfig => ({
  gateway: {
    host: '127.0.0.1',
    port: 8787,
    token: 'test-gateway-token-value',
    ...overrides,
  },
  mcpServers,
});

describe('src/core/ipv4', () => {
  test('ipv4Number converts dotted-quad and IPv4-mapped IPv6 addresses to unsigned 32-bit integers', () => {
    expect(ipv4Number('0.0.0.0')).toBe(0);
    expect(ipv4Number('127.0.0.1')).toBe(0x7f000001);
    expect(ipv4Number('192.168.1.1')).toBe(0xc0a80101);
    expect(ipv4Number('255.255.255.255')).toBe(0xffffffff);

    // Dotted IPv4-mapped IPv6
    expect(ipv4Number('::ffff:192.168.1.50')).toBe(0xc0a80132);
    expect(ipv4Number('::FFFF:10.0.0.1')).toBe(0x0a000001);

    // Hex IPv4-mapped IPv6
    expect(ipv4Number('::ffff:7f00:1')).toBe(0x7f000001);
    expect(ipv4Number('::ffff:7f00:0001')).toBe(0x7f000001);
    expect(ipv4Number('::ffff:c0a8:0101')).toBe(0xc0a80101);
    expect(ipv4Number('::FFFF:C0A8:0101')).toBe(0xc0a80101);
  });

  test('ipv4Number rejects leading zeros, out-of-range octets, wrong arity, negatives, and non-mapped IPv6', () => {
    const invalid = [
      '',
      '01.2.3.4',
      '192.168.01.1',
      '00.0.0.0',
      '::ffff:01.2.3.4',
      '256.0.0.1',
      '1.2.3.999',
      '127.0.1',
      '1.2.3.4.5',
      '-1.0.0.1',
      '1.-2.3.4',
      '::1',
      'fe80::1',
      '::',
      '2001:db8::1',
      '::ffff:12345:1',
      '::ffff:gggg:0001',
    ];
    for (const input of invalid) {
      expect(ipv4Number(input)).toBeNull();
    }
  });

  test('parseIpv4Range and inIpv4Range parse valid CIDRs and check membership accurately', () => {
    const r8 = parseIpv4Range('10.0.0.0/8');
    expect(r8).toEqual({ network: 0x0a000000, mask: 0xff000000 });
    expect(r8 && inIpv4Range(mustIp('10.0.0.0'), r8)).toBe(true);
    expect(r8 && inIpv4Range(mustIp('10.255.255.255'), r8)).toBe(true);
    expect(r8 && inIpv4Range(mustIp('11.0.0.0'), r8)).toBe(false);

    const r10 = parseIpv4Range('100.64.0.0/10');
    expect(r10).toEqual({ network: 0x64400000, mask: 0xffc00000 });
    expect(r10 && inIpv4Range(mustIp('100.64.0.0'), r10)).toBe(true);
    expect(r10 && inIpv4Range(mustIp('100.127.255.255'), r10)).toBe(true);
    expect(r10 && inIpv4Range(mustIp('100.128.0.0'), r10)).toBe(false);

    const r32 = parseIpv4Range('192.168.1.5/32');
    expect(r32).toEqual({ network: 0xc0a80105, mask: 0xffffffff });
    expect(r32 && inIpv4Range(mustIp('192.168.1.5'), r32)).toBe(true);
    expect(r32 && inIpv4Range(mustIp('192.168.1.6'), r32)).toBe(false);

    const r0 = parseIpv4Range('0.0.0.0/0');
    expect(r0).toEqual({ network: 0, mask: 0 });
    expect(r0 && inIpv4Range(mustIp('0.0.0.0'), r0)).toBe(true);
    expect(r0 && inIpv4Range(mustIp('255.255.255.255'), r0)).toBe(true);
  });

  test('parseIpv4Range rejects host bits set, prefix > 32, leading zeros in prefix, and invalid addresses', () => {
    const invalid = [
      '192.168.1.1/24',
      '10.0.0.1/8',
      '0.0.0.1/0',
      '10.0.0.0/33',
      '0.0.0.0/99',
      '10.0.0.0/08',
      '0.0.0.0/00',
      '256.0.0.0/8',
      '10.0.0.0',
      '10.0.0.0/-1',
      'not-an-ip/24',
    ];
    for (const input of invalid) {
      expect(parseIpv4Range(input)).toBeNull();
    }
  });

  test('isSharedIpv4 and isLinkLocalIpv4 match exact RFC 6598 and RFC 3927 boundaries', () => {
    expect(isSharedIpv4(mustIp('100.64.0.0'))).toBe(true);
    expect(isSharedIpv4(mustIp('100.100.50.1'))).toBe(true);
    expect(isSharedIpv4(mustIp('100.127.255.255'))).toBe(true);
    expect(isSharedIpv4(mustIp('100.63.255.255'))).toBe(false);
    expect(isSharedIpv4(mustIp('100.128.0.0'))).toBe(false);
    expect(isSharedIpv4(mustIp('10.0.0.1'))).toBe(false);

    expect(isLinkLocalIpv4(mustIp('169.254.0.0'))).toBe(true);
    expect(isLinkLocalIpv4(mustIp('169.254.169.254'))).toBe(true);
    expect(isLinkLocalIpv4(mustIp('169.254.255.255'))).toBe(true);
    expect(isLinkLocalIpv4(mustIp('169.253.255.255'))).toBe(false);
    expect(isLinkLocalIpv4(mustIp('169.255.0.0'))).toBe(false);
  });

  test('isLocalIpv4 and isLocalRange classify RFC 1918 and 100.64.0.0/10 subnets and reject supernets or public ranges', () => {
    for (const ip of [
      '10.0.0.0',
      '10.255.255.255',
      '172.16.0.0',
      '172.31.255.255',
      '192.168.0.0',
      '192.168.255.255',
      '100.64.0.0',
      '100.127.255.255',
    ]) {
      expect(isLocalIpv4(mustIp(ip))).toBe(true);
    }

    for (const ip of [
      '172.15.255.255',
      '172.32.0.0',
      '192.167.255.255',
      '127.0.0.1',
      '169.254.169.254',
      '8.8.8.8',
    ]) {
      expect(isLocalIpv4(mustIp(ip))).toBe(false);
    }

    for (const cidr of [
      '10.0.0.0/8',
      '10.20.0.0/16',
      '172.16.0.0/12',
      '172.20.1.0/24',
      '192.168.0.0/16',
      '192.168.1.0/24',
      '192.168.1.5/32',
      '100.64.0.0/10',
      '100.100.0.0/16',
    ]) {
      expect(isLocalRange(mustRange(cidr))).toBe(true);
    }

    for (const cidr of [
      '100.0.0.0/8',
      '172.0.0.0/8',
      '192.0.0.0/8',
      '0.0.0.0/0',
      '8.8.8.0/24',
      '169.254.0.0/16',
      '127.0.0.0/8',
    ]) {
      expect(isLocalRange(mustRange(cidr))).toBe(false);
    }
  });
});

describe('src/core/network', () => {
  test('compileAllowedPeers returns undefined for undefined input and filters invalid CIDRs', () => {
    expect(compileAllowedPeers(undefined)).toBeUndefined();
    expect(compileAllowedPeers([])).toEqual([]);
    expect(
      compileAllowedPeers(['10.0.0.0/8', '192.168.1.1/24', 'bad-cidr', '100.64.0.0/10']),
    ).toEqual([mustRange('10.0.0.0/8'), mustRange('100.64.0.0/10')]);
  });

  test('interfaceChoices and selectInterface expose loopback and reject unassigned public addresses', () => {
    const choices = interfaceChoices();
    expect(
      choices.some((choice) => choice.address === '127.0.0.1' && choice.kind === 'loopback'),
    ).toBe(true);

    const loopback = selectInterface('127.0.0.1');
    expect(loopback.address).toBe('127.0.0.1');
    expect(loopback.kind).toBe('loopback');

    let thrown: unknown;
    try {
      selectInterface('203.0.113.1');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    expect((thrown as GatewayError).code).toBe('NetworkPolicy');
    expect((thrown as GatewayError).message).toBe(
      'Select a currently assigned private, 100.64.0.0/10 or loopback IPv4 address.',
    );
  });

  test('peerAllowed enforces loopback listener policy', () => {
    const loopback: InterfaceChoice = {
      name: 'lo0',
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      kind: 'loopback',
    };

    expect(peerAllowed('127.0.0.1', loopback)).toBe(true);
    expect(peerAllowed('127.0.0.2', loopback)).toBe(true);
    expect(peerAllowed('::1', loopback)).toBe(true);
    expect(peerAllowed('::ffff:127.0.0.1', loopback)).toBe(true);
    expect(peerAllowed('::ffff:7f00:0001', loopback)).toBe(true);

    expect(peerAllowed('192.168.1.10', loopback)).toBe(false);
    expect(peerAllowed('192.168.1.10', loopback, ['192.168.1.0/24'])).toBe(false);
    expect(peerAllowed('8.8.8.8', loopback)).toBe(false);
    expect(peerAllowed('fe80::1', loopback)).toBe(false);
    expect(peerAllowed('not-an-ip', loopback)).toBe(false);
  });

  test('peerAllowed enforces LAN netmask and rejects ::1, other subnets, and public IPs even under 0.0.0.0 netmask', () => {
    const lan: InterfaceChoice = {
      name: 'en0',
      address: '192.168.1.10',
      netmask: '255.255.255.0',
      kind: 'lan',
    };

    expect(peerAllowed('127.0.0.1', lan)).toBe(true);
    expect(peerAllowed('::ffff:127.0.0.1', lan)).toBe(true);
    expect(peerAllowed('192.168.1.50', lan)).toBe(true);
    expect(peerAllowed('::ffff:192.168.1.50', lan)).toBe(true);
    expect(peerAllowed('::ffff:c0a8:0119', lan)).toBe(true);

    expect(peerAllowed('::1', lan)).toBe(false);
    expect(peerAllowed('192.168.2.50', lan)).toBe(false);
    expect(peerAllowed('8.8.8.8', lan)).toBe(false);
    expect(peerAllowed('169.254.169.254', lan)).toBe(false);

    const wideLan: InterfaceChoice = {
      name: 'en0',
      address: '192.168.1.10',
      netmask: '0.0.0.0',
      kind: 'lan',
    };
    expect(peerAllowed('8.8.8.8', wideLan)).toBe(false);
    expect(peerAllowed('169.254.1.1', wideLan)).toBe(false);
    expect(peerAllowed('192.168.2.50', wideLan)).toBe(true);
  });

  test('peerAllowed overrides /32 tunnel interface netmask with string or compiled allowedPeers', () => {
    const utun: InterfaceChoice = {
      name: 'utun4',
      address: '100.64.1.2',
      netmask: '255.255.255.255',
      kind: 'tailscale',
    };

    // Without allowedPeers, /32 only admits exact address (plus loopback).
    expect(peerAllowed('100.64.1.2', utun)).toBe(true);
    expect(peerAllowed('100.64.1.3', utun)).toBe(false);

    // String allowedPeers
    expect(peerAllowed('100.64.1.3', utun, ['100.64.0.0/10'])).toBe(true);
    expect(peerAllowed('::ffff:100.100.2.3', utun, ['100.64.0.0/10'])).toBe(true);
    expect(peerAllowed('192.168.1.50', utun, ['100.64.0.0/10'])).toBe(false);
    expect(peerAllowed('8.8.8.8', utun, ['0.0.0.0/0'])).toBe(false);
    expect(peerAllowed('100.64.1.3', utun, ['invalid-cidr', '100.64.0.0/10'])).toBe(true);

    // CompiledPeerRange allowedPeers
    const compiled = compileAllowedPeers(['100.64.0.0/10']);
    expect(peerAllowed('100.64.1.3', utun, compiled)).toBe(true);
    expect(peerAllowed('192.168.1.50', utun, compiled)).toBe(false);
  });

  test('validateHostHeader validates exact host:port, port-80 bare host, case-insensitive IPv6, and rejects rebinding', () => {
    expect(validateHostHeader('127.0.0.1:8787', '127.0.0.1', 8787)).toBe(true);
    expect(validateHostHeader('127.0.0.1', '127.0.0.1', 80)).toBe(true);
    expect(validateHostHeader('127.0.0.1:80', '127.0.0.1', 80)).toBe(true);
    expect(validateHostHeader('127.0.0.1', '127.0.0.1', 8787)).toBe(false);

    expect(validateHostHeader('[::1]:8787', '::1', 8787)).toBe(true);
    expect(validateHostHeader('[::1]:8787', '[::1]', 8787)).toBe(true);
    expect(validateHostHeader('[FE80::AB]:8787', 'fe80::ab', 8787)).toBe(true);
    expect(validateHostHeader('[::1]', '::1', 80)).toBe(true);

    expect(validateHostHeader(undefined, '127.0.0.1', 8787)).toBe(false);
    expect(validateHostHeader('', '127.0.0.1', 8787)).toBe(false);
    expect(validateHostHeader('127.0.0.1:9999', '127.0.0.1', 8787)).toBe(false);
    expect(validateHostHeader('evil.example.com:8787', '127.0.0.1', 8787)).toBe(false);
    expect(validateHostHeader('localhost:8787', '127.0.0.1', 8787)).toBe(false);
  });

  test('validateOriginHeader allows absent Origin and exact http listener origin while rejecting mismatches', () => {
    expect(validateOriginHeader(undefined, '127.0.0.1', 8787)).toBe(true);
    expect(validateOriginHeader('http://127.0.0.1:8787', '127.0.0.1', 8787)).toBe(true);
    expect(validateOriginHeader('http://127.0.0.1', '127.0.0.1', 80)).toBe(true);

    expect(validateOriginHeader('http://127.0.0.1:80', '127.0.0.1', 80)).toBe(false);
    expect(validateOriginHeader('http://evil.example.com', '127.0.0.1', 8787)).toBe(false);
    expect(validateOriginHeader('null', '127.0.0.1', 8787)).toBe(false);
    expect(validateOriginHeader('https://127.0.0.1:8787', '127.0.0.1', 8787)).toBe(false);
    expect(validateOriginHeader('http://127.0.0.1:8788', '127.0.0.1', 8787)).toBe(false);
  });

  test('rejectSelfProxy passes for stdio, disabled, and different-port HTTP upstreams', async () => {
    const config = makeConfig(
      { host: '127.0.0.1', port: 8787 },
      {
        stdioServer: { command: '/bin/echo', args: ['hi'] },
        disabledSelf: { url: 'http://127.0.0.1:8787/mcp', disabled: true },
        differentPort: { url: 'http://127.0.0.1:9999/mcp' },
        defaultHttpPort: { url: 'http://127.0.0.1/mcp' },
        defaultHttpsPort: { url: 'https://127.0.0.1/mcp' },
      },
    );

    await expect(rejectSelfProxy(config)).resolves.toBeUndefined();
  });

  test('rejectSelfProxy rejects enabled HTTP upstreams pointing back to the gateway listener', async () => {
    for (const url of [
      'http://127.0.0.1:8787/mcp',
      'http://localhost:8787/mcp',
      'http://0.0.0.0:8787/mcp',
      'http://[::]:8787/mcp',
    ]) {
      const config = makeConfig({ host: '127.0.0.1', port: 8787 }, { loop: { url } });
      let thrown: unknown;
      try {
        await rejectSelfProxy(config);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GatewayError);
      expect((thrown as GatewayError).code).toBe('NetworkPolicy');
      expect((thrown as GatewayError).message).toBe(
        'An upstream must not point back to this gateway listener.',
      );
      expect(isSelfProxyCancelled(thrown)).toBe(false);
    }
  });

  test('rejectSelfProxy handles pre-aborted signal, expired deadline, and unparseable URL', async () => {
    const stdioOnly = makeConfig({}, { stdio: { command: '/bin/echo' } });

    const aborted = new AbortController();
    aborted.abort();
    let cancelledErr: unknown;
    try {
      await rejectSelfProxy(stdioOnly, { signal: aborted.signal });
    } catch (error) {
      cancelledErr = error;
    }
    expect(cancelledErr).toBeInstanceOf(GatewayError);
    expect((cancelledErr as GatewayError).code).toBe('Cancelled');
    expect(isSelfProxyCancelled(cancelledErr)).toBe(true);
    expect(isSelfProxyCancelled(failure('NetworkPolicy', 'other'))).toBe(false);
    expect(isSelfProxyCancelled(new Error('plain'))).toBe(false);
    expect(isSelfProxyCancelled(null)).toBe(false);

    let expiredErr: unknown;
    try {
      await rejectSelfProxy(stdioOnly, { deadline: Date.now() - 1 });
    } catch (error) {
      expiredErr = error;
    }
    expect(expiredErr).toBeInstanceOf(GatewayError);
    expect((expiredErr as GatewayError).code).toBe('NetworkPolicy');
    expect((expiredErr as GatewayError).message).toBe(
      'An upstream address could not be checked before the deadline.',
    );

    const badUrl = makeConfig({}, { broken: { url: 'not a valid url' } });
    let badUrlErr: unknown;
    try {
      await rejectSelfProxy(badUrl);
    } catch (error) {
      badUrlErr = error;
    }
    expect(badUrlErr).toBeInstanceOf(GatewayError);
    expect((badUrlErr as GatewayError).code).toBe('NetworkPolicy');
    expect((badUrlErr as GatewayError).message).toBe(
      'An upstream hostname could not be checked for self-proxy recursion.',
    );
  });
});
