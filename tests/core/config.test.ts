import { dlopen, FFIType } from 'bun:ffi';
import { describe, expect, test } from 'bun:test';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import {
  ConfigStore,
  effectiveServerToken,
  ensureParent,
  isDisallowedUpstreamUrl,
  isHttpServer,
  keyRefs,
  parseConfig,
  parseConfigWithSlots,
  previewConfig,
  readPrivateText,
  resolveKeys,
  serverFingerprint,
  writePrivateTextAtomic,
} from '@mcp-gateway/core/config';
import { MAX_CONFIG_BYTES } from '@mcp-gateway/shared/config-document';
import type { ConfigFile, HttpServerConfig, StdioServerConfig } from '@mcp-gateway/shared/types';
import {
  DEFAULT_TEST_TOKEN,
  expectAsyncGatewayError,
  expectGatewayError,
  makeConfigText,
  registerTempDirLifecycle,
} from '../helpers/core';

const GW_TOKEN = DEFAULT_TEST_TOKEN;
const SERVER_TOKEN = 'server-fixture-token-0123456789abcdef01';
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-9222-222222222222';
const UUID_3 = '33333333-3333-4333-a333-333333333333';

const envRef = (name: string): string => `\${${name}}`;

const LOCK_EX_NB = 6;
const libSystem = dlopen('libSystem.B.dylib', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

const makeConfig = (
  gatewayOverrides: Record<string, unknown> = {},
  mcpServers: Record<string, unknown> = {},
): string => makeConfigText({ gateway: gatewayOverrides, mcpServers });

const { makeTempDir } = registerTempDirLifecycle('bear-mcp-config-');

describe('isDisallowedUpstreamUrl', () => {
  test('returns true for link-local and unspecified IPv4 and IPv6 addresses', () => {
    const disallowed = [
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.0.1/mcp',
      'http://0.0.0.0:8080/mcp',
      'http://0.1.2.3/mcp',
      'http://[fe80::1]/mcp',
      'http://[febf::1]/mcp',
      'http://[::]/mcp',
    ];
    for (const raw of disallowed) {
      expect(isDisallowedUpstreamUrl(new URL(raw))).toBe(true);
    }
  });

  test('returns false for loopback, private LAN, and public hostnames', () => {
    const allowed = [
      'http://127.0.0.1:8080/mcp',
      'http://192.168.1.10:8080/mcp',
      'https://api.example.com/mcp',
    ];
    for (const raw of allowed) {
      expect(isDisallowedUpstreamUrl(new URL(raw))).toBe(false);
    }
  });
});

describe('parseConfig and parseConfigWithSlots', () => {
  test('parses valid stdio and HTTP configurations in JSON and JSONC with environment expansion', () => {
    const env: NodeJS.ProcessEnv = {
      GW_HOST: '127.0.0.1',
      GW_TOKEN,
      HTTP_TOKEN: SERVER_TOKEN,
      UPSTREAM_URL: 'https://api.example.com/mcp',
      API_KEY: 'secret-value-1234',
      BIN_PATH: '/usr/local/bin/mcp-server',
      ARG_ONE: '--stdio',
      WORK_DIR: '/var/empty',
      APP_MODE: 'production',
    };

    const jsonText = JSON.stringify({
      gateway: {
        host: envRef('GW_HOST'),
        port: 4000,
        token: envRef('GW_TOKEN'),
        autoStart: true,
        launchAtLogin: false,
        keepAwake: true,
      },
      mcpServers: {
        remote_api: {
          url: envRef('UPSTREAM_URL'),
          token: envRef('HTTP_TOKEN'),
          headers: {
            'X-Custom-Auth': `Bearer ${envRef('API_KEY')}`,
          },
          legacyProtocol: true,
        },
        local_tool: {
          command: envRef('BIN_PATH'),
          args: ['run', envRef('ARG_ONE')],
          cwd: envRef('WORK_DIR'),
          env: {
            APP_MODE: envRef('APP_MODE'),
          },
          disabled: false,
        },
      },
    });

    const parsed = parseConfig(jsonText, env, 'json');
    expect(parsed.gateway.host).toBe('127.0.0.1');
    expect(parsed.gateway.port).toBe(4000);
    expect(parsed.gateway.token).toBe(GW_TOKEN);
    expect(parsed.gateway.autoStart).toBe(true);
    expect(parsed.gateway.keepAwake).toBe(true);

    const httpServer = parsed.mcpServers.remote_api;
    expect(httpServer).toBeDefined();
    expect(httpServer && isHttpServer(httpServer)).toBe(true);
    if (httpServer && isHttpServer(httpServer)) {
      expect(httpServer.url).toBe('https://api.example.com/mcp');
      expect(httpServer.token).toBe(SERVER_TOKEN);
      expect(httpServer.headers).toEqual({ 'x-custom-auth': 'Bearer secret-value-1234' });
      expect(httpServer.legacyProtocol).toBe(true);
    }

    const stdioServer = parsed.mcpServers.local_tool;
    expect(stdioServer).toBeDefined();
    expect(stdioServer && isHttpServer(stdioServer)).toBe(false);
    if (stdioServer && !isHttpServer(stdioServer)) {
      expect(stdioServer.command).toBe('/usr/local/bin/mcp-server');
      expect(stdioServer.args).toEqual(['run', '--stdio']);
      expect(stdioServer.cwd).toBe('/var/empty');
      expect(stdioServer.env).toEqual({ APP_MODE: 'production' });
    }

    const jsoncText = `{
      // Gateway settings
      "gateway": {
        "host": "\${GW_HOST}",
        "port": 4001,
        "token": "\${GW_TOKEN}",
      },
      "mcpServers": {
        /* Trailing comma allowed in JSONC */
        "local_tool": {
          "command": "\${BIN_PATH}",
        },
      },
    }`;

    const jsoncParsed = parseConfig(jsoncText, env, 'jsonc');
    expect(jsoncParsed.gateway.port).toBe(4001);
    expectGatewayError(
      () => parseConfig(jsoncText, env, 'json'),
      'InvalidConfig',
      'Configuration does not match the supported schema.',
    );
  });

  test('rejects documents exceeding MAX_CONFIG_BYTES', () => {
    const padding = ' '.repeat(MAX_CONFIG_BYTES + 1);
    const oversized = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${GW_TOKEN}"},"mcpServers":{}}${padding}`;

    expectGatewayError(
      () => parseConfig(oversized, {}),
      'InvalidConfig',
      'Configuration exceeds the size limit.',
    );
    expectGatewayError(
      () => parseConfigWithSlots(oversized, {}),
      'InvalidConfig',
      'Configuration exceeds the size limit.',
    );
  });

  test('rejects inherited Object keys like constructor, missing env vars, and NUL characters', () => {
    expectGatewayError(
      () => parseConfig(makeConfig({ host: envRef('constructor') }), {}),
      'InvalidConfig',
      'A referenced environment variable is not defined.',
    );

    expectGatewayError(
      () => parseConfig(makeConfig({ host: envRef('MISSING_VAR') }), {}),
      'InvalidConfig',
      'A referenced environment variable is not defined.',
    );

    expectGatewayError(
      () =>
        parseConfig(makeConfig({}, { svc: { command: '/bin/echo', args: [envRef('BAD_ARG')] } }), {
          BAD_ARG: 'hello\0world',
        }),
      'InvalidConfig',
      'NUL characters are not allowed.',
    );
  });

  test('validates gateway.port integer bounds 1..65535', () => {
    expect(parseConfig(makeConfig({ port: 1 }), {}).gateway.port).toBe(1);
    expect(parseConfig(makeConfig({ port: 65535 }), {}).gateway.port).toBe(65535);

    for (const port of [0, -1, 65536, 3.14]) {
      expectGatewayError(
        () => parseConfig(makeConfig({ port }), {}),
        'InvalidConfig',
        'The listener port must be an integer from 1 to 65535.',
      );
    }

    // 1e309 parses to Infinity (typeof === 'number'), reaching the integer range check.
    const infinityPort = `{"gateway":{"host":"127.0.0.1","port":1e309,"token":"${GW_TOKEN}"},"mcpServers":{}}`;
    expectGatewayError(
      () => parseConfig(infinityPort, {}),
      'InvalidConfig',
      'The listener port must be an integer from 1 to 65535.',
    );

    // NaN is not valid JSON syntax and "NaN" is not a number.
    const rawNanPort = `{"gateway":{"host":"127.0.0.1","port":NaN,"token":"${GW_TOKEN}"},"mcpServers":{}}`;
    expectGatewayError(
      () => parseConfig(rawNanPort, {}),
      'InvalidConfig',
      'Configuration does not match the supported schema.',
    );
    expectGatewayError(
      () => parseConfig(makeConfig({ port: 'NaN' }), {}),
      'InvalidConfig',
      'Configuration does not match the supported schema.',
    );
  });

  test('validates gateway and server token / tokenRef slots', () => {
    // Missing both token and tokenRef on gateway.
    expectGatewayError(
      () =>
        parseConfig(
          JSON.stringify({
            gateway: { host: '127.0.0.1', port: 3333 },
            mcpServers: {},
          }),
          {},
        ),
      'InvalidConfig',
      'The gateway needs a token or a tokenRef.',
    );

    // Both token and tokenRef on gateway or server.
    expectGatewayError(
      () => parseConfig(makeConfig({ token: GW_TOKEN, tokenRef: UUID_1 }), {}),
      'InvalidConfig',
      'A key cannot have both token and tokenRef; keep one.',
    );
    expectGatewayError(
      () =>
        parseConfig(
          makeConfig({}, { svc: { command: '/bin/echo', token: SERVER_TOKEN, tokenRef: UUID_2 } }),
          {},
        ),
      'InvalidConfig',
      'A key cannot have both token and tokenRef; keep one.',
    );

    // Token length boundaries (32..512) and printable non-space ASCII.
    expect(parseConfig(makeConfig({ token: 'a'.repeat(32) }), {}).gateway.token).toBe(
      'a'.repeat(32),
    );
    expect(parseConfig(makeConfig({ token: 'z'.repeat(512) }), {}).gateway.token).toBe(
      'z'.repeat(512),
    );
    for (const badToken of [
      'a'.repeat(31),
      'a'.repeat(513),
      `${'a'.repeat(16)} ${'b'.repeat(16)}`,
      `${'a'.repeat(31)}é`,
    ]) {
      expectGatewayError(
        () => parseConfig(makeConfig({ token: badToken }), {}),
        'InvalidConfig',
        'The bearer token must contain 32 to 512 printable non-space ASCII characters.',
      );
      expectGatewayError(
        () => parseConfig(makeConfig({}, { svc: { command: '/bin/echo', token: badToken } }), {}),
        'InvalidConfig',
        'A server token must contain 32 to 512 printable non-space ASCII characters.',
      );
    }

    // Valid lowercase UUID v4 tokenRef succeeds.
    const refConfig = parseConfig(
      JSON.stringify({
        gateway: { host: '127.0.0.1', port: 3333, tokenRef: UUID_1 },
        mcpServers: {
          svc: { command: '/bin/echo', tokenRef: UUID_2 },
        },
      }),
      {},
    );
    expect(refConfig.gateway.tokenRef).toBe(UUID_1);
    expect(refConfig.mcpServers.svc?.tokenRef).toBe(UUID_2);

    // Invalid tokenRef formats rejected (uppercase hex, non-v4, bad variant, random string).
    for (const badRef of [
      UUID_3.toUpperCase(),
      '11111111-1111-1111-8111-111111111111',
      '11111111-1111-4111-0111-111111111111',
      'not-a-uuid',
    ]) {
      expectGatewayError(
        () =>
          parseConfig(
            JSON.stringify({
              gateway: { host: '127.0.0.1', port: 3333, tokenRef: badRef },
              mcpServers: {},
            }),
            {},
          ),
        'InvalidConfig',
        'A tokenRef must be a key ID created by MCP Gateway.',
      );
    }
  });

  test('enforces 100.64.0.0/10 shared-space and allowedPeers rules', () => {
    // Shared-space host without allowedPeers is rejected.
    expectGatewayError(
      () => parseConfig(makeConfig({ host: '100.64.0.1' }), {}),
      'InvalidConfig',
      'A 100.64.0.0/10 address needs allowedPeers, such as ["100.64.0.0/10"].',
    );

    // Shared-space host with valid allowedPeers is accepted.
    const sharedOk = parseConfig(
      makeConfig({ host: '100.100.1.2', allowedPeers: ['100.64.0.0/10', '192.168.1.0/24'] }),
      {},
    );
    expect(sharedOk.gateway.allowedPeers).toEqual(['100.64.0.0/10', '192.168.1.0/24']);

    // allowedPeers on 127.* loopback is rejected.
    expectGatewayError(
      () => parseConfig(makeConfig({ host: '127.0.0.1', allowedPeers: ['192.168.1.0/24'] }), {}),
      'InvalidConfig',
      'allowedPeers cannot be used with a loopback address.',
    );

    // Empty allowedPeers is rejected.
    expectGatewayError(
      () => parseConfig(makeConfig({ host: '192.168.1.10', allowedPeers: [] }), {}),
      'InvalidConfig',
      'allowedPeers must list 1 to 16 address ranges.',
    );

    // More than 16 allowedPeers is rejected (16 is accepted).
    const sixteenPeers = Array.from({ length: 16 }, (_, i) => `10.0.${i}.0/24`);
    expect(
      parseConfig(makeConfig({ host: '192.168.1.10', allowedPeers: sixteenPeers }), {}).gateway
        .allowedPeers,
    ).toHaveLength(16);
    const seventeenPeers = [...sixteenPeers, '10.0.16.0/24'];
    expectGatewayError(
      () => parseConfig(makeConfig({ host: '192.168.1.10', allowedPeers: seventeenPeers }), {}),
      'InvalidConfig',
      'allowedPeers must list 1 to 16 address ranges.',
    );

    // Non-local or malformed ranges in allowedPeers are rejected.
    for (const badPeer of ['8.8.8.0/24', '0.0.0.0/0', '169.254.0.0/16', '192.168.1.1/24', 'nope']) {
      expectGatewayError(
        () => parseConfig(makeConfig({ host: '100.64.0.1', allowedPeers: [badPeer] }), {}),
        'InvalidConfig',
        'Each allowedPeers entry must be a private or 100.64.0.0/10 IPv4 range, such as 100.64.0.0/10.',
      );
    }
  });

  test('enforces 64-server cap and SAFE_NAME server names', () => {
    const servers64: Record<string, unknown> = {};
    for (let i = 0; i < 64; i++) {
      servers64[`srv-${i}`] = { command: '/bin/echo' };
    }
    expect(Object.keys(parseConfig(makeConfig({}, servers64), {}).mcpServers)).toHaveLength(64);

    const servers65 = { ...servers64, 'srv-64': { command: '/bin/echo' } };
    expectGatewayError(
      () => parseConfig(makeConfig({}, servers65), {}),
      'InvalidConfig',
      'At most 64 servers are supported.',
    );

    // __proto__ as a JSON key is preserved as own data by ownRecord and rejected by SAFE_NAME.
    for (const badName of ['-leading-dash', '__proto__']) {
      const text = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${GW_TOKEN}"},"mcpServers":{"${badName}":{"command":"/bin/echo"}}}`;
      expectGatewayError(
        () => parseConfig(text, {}),
        'InvalidConfig',
        'Server names must be safe URL path segments.',
      );
    }
  });

  test('enforces HTTP server URL, network policy, and header rules', () => {
    // Invalid URL syntax.
    expectGatewayError(
      () => parseConfig(makeConfig({}, { api: { url: 'not a url' } }), {}),
      'InvalidConfig',
      'An upstream URL is invalid.',
    );

    // Unsupported schemes, userinfo, and fragments.
    for (const badUrl of [
      'ftp://example.com/mcp',
      'file:///etc/passwd',
      'https://user@example.com/mcp',
      'https://user:pass@example.com/mcp',
      'https://example.com/mcp#frag',
    ]) {
      expectGatewayError(
        () => parseConfig(makeConfig({}, { api: { url: badUrl } }), {}),
        'InvalidConfig',
        'Upstreams require HTTP(S) URLs without userinfo or fragments.',
      );
    }

    // Disallowed link-local / metadata / unspecified upstream URLs throw NetworkPolicy.
    for (const blockedUrl of [
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0:8080/mcp',
      'http://[fe80::1]/mcp',
      'http://[::]/mcp',
    ]) {
      expectGatewayError(
        () => parseConfig(makeConfig({}, { api: { url: blockedUrl } }), {}),
        'NetworkPolicy',
        'Link-local and cloud metadata upstream addresses are not allowed.',
      );
    }

    // Lowercases header names.
    const ok = parseConfig(
      makeConfig(
        {},
        {
          api: {
            url: 'https://api.example.com/mcp',
            headers: { 'X-API-Key': 'abc', Authorization: 'Bearer xyz' },
          },
        },
      ),
      {},
    );
    const api = ok.mcpServers.api as HttpServerConfig;
    expect(api.headers).toEqual({ 'x-api-key': 'abc', authorization: 'Bearer xyz' });

    // Duplicate case-insensitive header names rejected.
    expectGatewayError(
      () =>
        parseConfig(
          makeConfig(
            {},
            {
              api: {
                url: 'https://api.example.com/mcp',
                headers: { Authorization: 'Bearer a', authorization: 'Bearer b' },
              },
            },
          ),
          {},
        ),
      'InvalidConfig',
      'Duplicate upstream header names are not allowed.',
    );

    // Transport-policy headers rejected.
    for (const forbidden of [
      'Host',
      'Connection',
      'Content-Length',
      'Transfer-Encoding',
      'Upgrade',
      'Proxy-Authorization',
      'Proxy-Connection',
      'Mcp-Session-Id',
    ]) {
      expectGatewayError(
        () =>
          parseConfig(
            makeConfig(
              {},
              {
                api: {
                  url: 'https://api.example.com/mcp',
                  headers: { [forbidden]: 'value' },
                },
              },
            ),
            {},
          ),
        'InvalidConfig',
        'An upstream header attempts to override transport policy.',
      );
    }

    // Invalid header names and values rejected.
    expectGatewayError(
      () =>
        parseConfig(
          makeConfig(
            {},
            { api: { url: 'https://api.example.com/mcp', headers: { 'Bad Header': 'ok' } } },
          ),
          {},
        ),
      'InvalidConfig',
      'An upstream header is invalid.',
    );
    expectGatewayError(
      () =>
        parseConfig(
          makeConfig(
            {},
            { api: { url: 'https://api.example.com/mcp', headers: { 'X-Test': 'bad\r\nvalue' } } },
          ),
          {},
        ),
      'InvalidConfig',
      'An upstream header is invalid.',
    );
  });

  test('enforces stdio server command, absolute cwd, and env key rules', () => {
    expectGatewayError(
      () => parseConfig(makeConfig({}, { tool: { command: '   ' } }), {}),
      'InvalidConfig',
      'A command executable is required.',
    );

    expectGatewayError(
      () =>
        parseConfig(makeConfig({}, { tool: { command: '/bin/echo', cwd: 'relative/dir' } }), {}),
      'InvalidConfig',
      'A command working directory must be absolute.',
    );

    for (const badKey of ['1INVALID', 'BAD-KEY', 'HAS SPACE', '']) {
      expectGatewayError(
        () =>
          parseConfig(
            makeConfig({}, { tool: { command: '/bin/echo', env: { [badKey]: '1' } } }),
            {},
          ),
        'InvalidConfig',
        'A command environment key is invalid.',
      );
    }

    for (const blockedKey of [
      'NODE_OPTIONS',
      'node_options',
      'BUN_OPTIONS',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
    ]) {
      expectGatewayError(
        () =>
          parseConfig(
            makeConfig({}, { tool: { command: '/bin/echo', env: { [blockedKey]: '/tmp/x' } } }),
            {},
          ),
        'InvalidConfig',
        'A command environment key is not allowed for security reasons.',
      );
    }
  });

  test('parseConfigWithSlots identifies unexpanded literal tokens before env expansion', () => {
    const text = JSON.stringify({
      gateway: {
        host: '127.0.0.1',
        port: 3333,
        token: envRef('GW_TOKEN'),
      },
      mcpServers: {
        literal_srv: {
          command: '/bin/echo',
          token: SERVER_TOKEN,
        },
        env_srv: {
          url: 'https://api.example.com/mcp',
          token: envRef('HTTP_TOKEN'),
        },
      },
    });

    const { file, slots } = parseConfigWithSlots(text, {
      GW_TOKEN,
      HTTP_TOKEN: SERVER_TOKEN,
    });

    expect(file.gateway.token).toBe(GW_TOKEN);
    expect(file.mcpServers.literal_srv?.token).toBe(SERVER_TOKEN);
    expect(file.mcpServers.env_srv?.token).toBe(SERVER_TOKEN);
    expect(slots).toEqual({
      gateway: false,
      servers: ['literal_srv'],
    });

    const literalGatewayText = makeConfig({ token: GW_TOKEN }, { s: { command: '/bin/echo' } });
    const literalResult = parseConfigWithSlots(literalGatewayText, {});
    expect(literalResult.slots).toEqual({
      gateway: true,
      servers: [],
    });
  });
});

describe('previewConfig', () => {
  test('returns null on valid JSON and JSONC configurations', () => {
    expect(previewConfig(makeConfig({}, { s: { command: '/bin/echo' } }), {})).toBeNull();
    const jsonc = `{
      // valid comment
      "gateway": { "host": "127.0.0.1", "port": 3333, "token": "${GW_TOKEN}", },
      "mcpServers": {},
    }`;
    expect(previewConfig(jsonc, {}, 'jsonc')).toBeNull();
  });

  test('returns size error without parsing when exceeding MAX_CONFIG_BYTES', () => {
    const oversized = `${makeConfig()}${' '.repeat(MAX_CONFIG_BYTES + 1)}`;
    expect(previewConfig(oversized, {})).toEqual({
      message: 'Configuration exceeds the size limit.',
    });
  });

  test('returns exact source ranges for structural issues', () => {
    // Unknown property points at the property key name (key: true).
    const unknownPropText = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${GW_TOKEN}","bogus":1},"mcpServers":{}}`;
    const unknownIssue = previewConfig(unknownPropText, {});
    expect(unknownIssue).toEqual({
      message: 'An unknown property is present; remove or rename it.',
      offset: unknownPropText.indexOf('"bogus"'),
      length: '"bogus"'.length,
    });

    // Missing required property points at the parent object.
    const missingHostText = `{"gateway":{"port":3333,"token":"${GW_TOKEN}"},"mcpServers":{}}`;
    const gatewayObj = `{"port":3333,"token":"${GW_TOKEN}"}`;
    const missingIssue = previewConfig(missingHostText, {});
    expect(missingIssue).toEqual({
      message: 'The "host" property is required.',
      offset: missingHostText.indexOf(gatewayObj),
      length: gatewayObj.length,
    });

    // Wrong property type points at the offending value.
    const wrongTypeText = `{"gateway":{"host":123,"port":3333,"token":"${GW_TOKEN}"},"mcpServers":{}}`;
    const wrongTypeIssue = previewConfig(wrongTypeText, {});
    expect(wrongTypeIssue).toEqual({
      message: 'A property has the wrong type or value.',
      offset: wrongTypeText.indexOf('123'),
      length: '123'.length,
    });

    // Non-object root points at the root value.
    const arrayRootText = '[1, 2, 3]';
    expect(previewConfig(arrayRootText, {})).toEqual({
      message: 'The configuration must be a JSON object.',
      offset: 0,
      length: arrayRootText.length,
    });

    // Non-object mcpServers (e.g. array) points at the mcpServers value.
    const arrayServersText = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${GW_TOKEN}"},"mcpServers":[]}`;
    expect(previewConfig(arrayServersText, {})).toEqual({
      message: 'Servers must be an object with one entry per server.',
      offset: arrayServersText.indexOf('[]'),
      length: '[]'.length,
    });

    // Mixed stdio + HTTP server entry points at the server object.
    const mixedServerObj = '{"command":"/bin/echo","url":"https://api.example.com/mcp"}';
    const mixedText = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${GW_TOKEN}"},"mcpServers":{"both":${mixedServerObj}}}`;
    expect(previewConfig(mixedText, {})).toEqual({
      message: 'A server entry must use either command fields or URL fields, not both.',
      offset: mixedText.indexOf(mixedServerObj),
      length: mixedServerObj.length,
    });

    // Non-object server entry and wrong nested env/headers value.
    const badEntryText = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${GW_TOKEN}"},"mcpServers":{"bad":42}}`;
    expect(previewConfig(badEntryText, {})).toEqual({
      message: 'A server entry must be an object with supported fields.',
      offset: badEntryText.indexOf('42'),
      length: '42'.length,
    });

    const badEnvText = `{"gateway":{"host":"127.0.0.1","port":3333,"token":"${GW_TOKEN}"},"mcpServers":{"s":{"command":"/bin/echo","env":{"PORT":8080}}}}`;
    expect(previewConfig(badEnvText, {})).toEqual({
      message: 'A property has the wrong type or value.',
      offset: badEnvText.indexOf('8080'),
      length: '8080'.length,
    });

    // Semantic failure (structurally valid) falls back to the validation message without range.
    expect(previewConfig(makeConfig({ port: 0 }), {})).toEqual({
      message: 'The listener port must be an integer from 1 to 65535.',
    });
  });
});

describe('keyRefs, resolveKeys, effectiveServerToken, and serverFingerprint', () => {
  test('keyRefs deduplicates tokenRef UUIDs across gateway and mcpServers', () => {
    const config: ConfigFile = {
      gateway: { host: '127.0.0.1', port: 3333, tokenRef: UUID_1 },
      mcpServers: {
        a: { command: '/bin/echo', tokenRef: UUID_2 },
        b: { url: 'https://api.example.com/mcp', tokenRef: UUID_1 },
        c: { command: '/bin/true', token: SERVER_TOKEN },
        d: { command: '/bin/false', tokenRef: UUID_3 },
      },
    };
    expect(keyRefs(config)).toEqual([UUID_1, UUID_2, UUID_3]);
  });

  test('resolveKeys replaces tokenRefs, removes tokenRef, and rejects missing or invalid stored keys', () => {
    const config: ConfigFile = {
      gateway: { host: '127.0.0.1', port: 3333, tokenRef: UUID_1 },
      mcpServers: {
        ref_srv: { command: '/bin/echo', tokenRef: UUID_2 },
        lit_srv: { url: 'https://api.example.com/mcp', token: SERVER_TOKEN },
        inherit_srv: { command: '/bin/true' },
      },
    };

    const resolved = resolveKeys(
      config,
      new Map([
        [UUID_1, GW_TOKEN],
        [UUID_2, SERVER_TOKEN],
      ]),
    );

    expect(resolved.gateway.token).toBe(GW_TOKEN);
    expect('tokenRef' in resolved.gateway).toBe(false);
    expect(resolved.mcpServers.ref_srv?.token).toBe(SERVER_TOKEN);
    expect(resolved.mcpServers.ref_srv && 'tokenRef' in resolved.mcpServers.ref_srv).toBe(false);
    expect(resolved.mcpServers.lit_srv?.token).toBe(SERVER_TOKEN);
    expect(resolved.mcpServers.inherit_srv?.token).toBeUndefined();

    // Missing key in Map.
    expectGatewayError(
      () => resolveKeys(config, new Map([[UUID_1, GW_TOKEN]])),
      'InvalidConfig',
      'A referenced key was not loaded.',
    );

    // Invalid stored key format.
    expectGatewayError(
      () =>
        resolveKeys(
          config,
          new Map([
            [UUID_1, 'too-short'],
            [UUID_2, SERVER_TOKEN],
          ]),
        ),
      'InvalidConfig',
      'A stored key must contain 32 to 512 printable non-space ASCII characters.',
    );
  });

  test('effectiveServerToken prefers server.token and falls back to gateway.token', () => {
    const gateway = { host: '127.0.0.1', port: 3333, token: GW_TOKEN };
    const withToken: StdioServerConfig = { command: '/bin/echo', token: SERVER_TOKEN };
    const withoutToken: HttpServerConfig = { url: 'https://api.example.com/mcp' };

    expect(effectiveServerToken(gateway, withToken)).toBe(SERVER_TOKEN);
    expect(effectiveServerToken(gateway, withoutToken)).toBe(GW_TOKEN);
  });

  test('serverFingerprint normalizes URL, sorts headers/env keys, and normalizes legacyProtocol', () => {
    const httpA: HttpServerConfig = {
      url: 'HTTPS://API.EXAMPLE.COM:443/mcp',
      headers: { 'x-b': '2', 'x-a': '1' },
      legacyProtocol: false,
    };
    const httpB: HttpServerConfig = {
      url: 'https://api.example.com/mcp',
      headers: { 'x-a': '1', 'x-b': '2' },
    };
    const httpLegacy: HttpServerConfig = {
      ...httpB,
      legacyProtocol: true,
    };

    expect(serverFingerprint(httpA)).toBe(serverFingerprint(httpB));
    expect(serverFingerprint(httpA)).not.toBe(serverFingerprint(httpLegacy));

    const stdioA: StdioServerConfig = {
      command: '/bin/echo',
      env: { Z_VAR: 'last', A_VAR: 'first' },
      cwd: '/var/empty',
      legacyProtocol: false,
    };
    const stdioB: StdioServerConfig = {
      command: '/bin/echo',
      args: [],
      env: { A_VAR: 'first', Z_VAR: 'last' },
      cwd: '/var/empty',
    };
    const stdioLegacy: StdioServerConfig = {
      ...stdioB,
      legacyProtocol: true,
    };

    expect(serverFingerprint(stdioA)).toBe(serverFingerprint(stdioB));
    expect(serverFingerprint(stdioA)).not.toBe(serverFingerprint(stdioLegacy));
  });
});

describe('ensureParent, writePrivateTextAtomic, and readPrivateText', () => {
  test('creates 0o700 parent directories, writes 0o600 files atomically, and reads back valid UTF-8', async () => {
    const root = await makeTempDir();
    const nestedDir = join(root, 'nested', 'deep');
    const filePath = join(nestedDir, 'mcp.json');
    const content = '{"hello":"world — ✓"}\n';

    await writePrivateTextAtomic(filePath, content);

    const parentStat = await fs.lstat(join(root, 'nested'));
    const deepStat = await fs.lstat(nestedDir);
    const fileStat = await fs.lstat(filePath);
    expect(parentStat.mode & 0o777).toBe(0o700);
    expect(deepStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(await fs.readdir(nestedDir)).toEqual(['mcp.json']);

    const read = await readPrivateText(filePath);
    expect(read.text).toBe(content);
    expect(read.bytes.equals(Buffer.from(content, 'utf8'))).toBe(true);
  });

  test('ensureParent refuses symlinked ancestor directories', async () => {
    const root = await makeTempDir();
    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    await fs.mkdir(realDir, { mode: 0o700 });
    await fs.symlink(realDir, linkDir);

    await expectAsyncGatewayError(
      () => ensureParent(join(linkDir, 'child', 'mcp.json')),
      'UnsafeFile',
      'Configuration paths must not contain symlinks.',
    );
  });

  test('readPrivateText refuses symlinked files via O_NOFOLLOW', async () => {
    const root = await makeTempDir();
    const target = join(root, 'target.json');
    const link = join(root, 'mcp.json');
    await writePrivateTextAtomic(target, '{}\n');
    await fs.symlink(target, link);

    await expectAsyncGatewayError(
      () => readPrivateText(link),
      'UnsafeFile',
      'Symlinked configuration files are refused.',
    );
  });

  test('readPrivateText refuses group or world accessible files', async () => {
    const root = await makeTempDir();
    const filePath = join(root, 'mcp.json');
    await writePrivateTextAtomic(filePath, '{}\n');
    await fs.chmod(filePath, 0o644);

    await expectAsyncGatewayError(
      () => readPrivateText(filePath),
      'UnsafeFile',
      'The configuration must be an owner-only regular file with no hard links.',
    );
  });

  test('readPrivateText refuses files with a second hard link and includes .tmp recovery guidance', async () => {
    const root = await makeTempDir();
    const filePath = join(root, 'mcp.json');
    await writePrivateTextAtomic(filePath, '{}\n');
    await fs.link(filePath, `${filePath}.link`);

    await expectAsyncGatewayError(
      () => readPrivateText(filePath),
      'UnsafeFile',
      'The configuration file has a second hard link. If the app stopped while creating it, delete the hidden .mcp.json.<id>.tmp or .mcp.jsonc.<id>.tmp file in the same folder, then reopen the app.',
    );
  });

  test('readPrivateText refuses group or world writable parent directories', async () => {
    const root = await makeTempDir();
    const filePath = join(root, 'mcp.json');
    await writePrivateTextAtomic(filePath, '{}\n');
    await fs.chmod(root, 0o777);

    await expectAsyncGatewayError(
      () => readPrivateText(filePath),
      'UnsafeFile',
      'The configuration directory must be owned by this user and not writable by others.',
    );
  });

  test('readPrivateText refuses invalid UTF-8 bytes and oversized files', async () => {
    const root = await makeTempDir();
    const badUtf8Path = join(root, 'bad-utf8.json');
    await fs.writeFile(badUtf8Path, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    await fs.chmod(badUtf8Path, 0o600);

    await expectAsyncGatewayError(
      () => readPrivateText(badUtf8Path),
      'InvalidConfig',
      'Configuration must contain valid UTF-8.',
    );

    const bigPath = join(root, 'big.json');
    await writePrivateTextAtomic(bigPath, 'a'.repeat(65));
    await expectAsyncGatewayError(
      () => readPrivateText(bigPath, 64),
      'InvalidConfig',
      'Configuration exceeds the size limit.',
    );
  });
});

describe('ConfigStore', () => {
  test('initialize() creates mcp.json with 0o600 permissions on first run and returns text + revision', async () => {
    const root = await makeTempDir();
    const configPath = join(root, 'nested', 'mcp.json');
    const store = new ConfigStore(configPath);
    let calls = 0;

    const doc = await store.initialize(async () => {
      calls++;
      return { port: 3456, token: GW_TOKEN };
    });

    expect(calls).toBe(1);
    expect(store.format).toBe('json');
    expect(store.path).toBe(configPath);
    expect(doc.revision).toMatch(/^[0-9a-f]{64}$/);
    const parsed = parseConfig(doc.text, {}, store.format);
    expect(parsed.gateway.host).toBe('127.0.0.1');
    expect(parsed.gateway.port).toBe(3456);
    expect(parsed.gateway.token).toBe(GW_TOKEN);
    expect(parsed.mcpServers).toEqual({});

    const stat = await fs.lstat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);

    // Subsequent initialize() reads the existing file without invoking createGateway again.
    const second = await store.initialize(async () => {
      calls++;
      return { port: 9999, token: SERVER_TOKEN };
    });
    expect(calls).toBe(1);
    expect(second).toEqual(doc);
  });

  test('initialize() selects existing mcp.jsonc when mcp.json does not exist or when constructed with .jsonc path', async () => {
    const root = await makeTempDir();
    const jsonPath = join(root, 'mcp.json');
    const jsoncPath = join(root, 'mcp.jsonc');
    const jsoncText = `{\n  // existing jsonc\n  "gateway": { "host": "127.0.0.1", "port": 3333, "token": "${GW_TOKEN}", },\n  "mcpServers": {},\n}\n`;
    await writePrivateTextAtomic(jsoncPath, jsoncText);

    const store = new ConfigStore(jsonPath);
    let called = false;
    const doc = await store.initialize(async () => {
      called = true;
      return { port: 3333, token: GW_TOKEN };
    });

    expect(called).toBe(false);
    expect(store.format).toBe('jsonc');
    expect(store.path).toBe(jsoncPath);
    expect(doc.text).toBe(jsoncText);

    // Constructed directly with a .jsonc path derives jsonPath and jsoncPath accurately.
    const directStore = new ConfigStore(jsoncPath);
    expect(directStore.path).toBe(jsoncPath);
    expect(directStore.format).toBe('jsonc');
    const directDoc = await directStore.initialize(async () => ({ port: 4444, token: GW_TOKEN }));
    expect(directStore.path).toBe(jsoncPath);
    expect(directStore.format).toBe('jsonc');
    expect(directDoc).toEqual(doc);
  });

  test('initialize() and read() throw AmbiguousConfig when both mcp.json and mcp.jsonc exist', async () => {
    const root = await makeTempDir();
    const jsonPath = join(root, 'mcp.json');
    const jsoncPath = join(root, 'mcp.jsonc');
    const text = makeConfig();
    await writePrivateTextAtomic(jsonPath, text);
    await writePrivateTextAtomic(jsoncPath, text);

    const store = new ConfigStore(jsonPath);
    await expectAsyncGatewayError(
      () => store.initialize(async () => ({ port: 3333, token: GW_TOKEN })),
      'AmbiguousConfig',
      'Both configuration files exist; keep only one and reopen the app.',
    );

    await expectAsyncGatewayError(
      () => store.read(),
      'AmbiguousConfig',
      'Both configuration files exist; keep only one and reopen the app.',
    );

    const uninitializedStore = new ConfigStore(jsonPath);
    await expectAsyncGatewayError(
      () => uninitializedStore.read(),
      'AmbiguousConfig',
      'Both configuration files exist; keep only one and reopen the app.',
    );
  });

  test('read() and save() reject with ConfigIO when configuration filename switches between mcp.json and mcp.jsonc', async () => {
    const root = await makeTempDir();
    const jsonPath = join(root, 'mcp.json');
    const jsoncPath = join(root, 'mcp.jsonc');
    const store = new ConfigStore(jsonPath);
    const initial = await store.initialize(async () => ({ port: 3333, token: GW_TOKEN }));

    await fs.rename(jsonPath, jsoncPath);

    await expectAsyncGatewayError(
      () => store.read(),
      'ConfigIO',
      'The configuration filename changed; reopen the app to select it.',
    );
    await expectAsyncGatewayError(
      () => store.save(initial.text, initial.revision),
      'ConfigIO',
      'The configuration filename changed; reopen the app to select it.',
    );
  });

  test('read() before initialize() wraps missing-file ENOENT into ConfigIO and save() refuses a symlinked lock file', async () => {
    const root = await makeTempDir();
    const jsonPath = join(root, 'mcp.json');
    const store = new ConfigStore(jsonPath);

    await expectAsyncGatewayError(
      () => store.read(),
      'ConfigIO',
      'Configuration file access failed.',
    );

    const initial = await store.initialize(async () => ({ port: 3333, token: GW_TOKEN }));
    const lockPath = `${jsonPath}.lock`;
    const lockTarget = join(root, 'lock-target');
    await writePrivateTextAtomic(lockTarget, '');
    await fs.unlink(lockPath).catch(() => undefined);
    await fs.symlink(lockTarget, lockPath);

    await expectAsyncGatewayError(
      () => store.save(`${makeConfig({ port: 4444 })}\n`, initial.revision),
      'ConfigIO',
      'Configuration file access failed.',
    );

    // A non-owner-only lock file (or FIFO) triggers UnsafeFile inside acquireLock.
    await fs.unlink(lockPath);
    const mkfifoResult = Bun.spawnSync(['/usr/bin/mkfifo', '-m', '600', lockPath]);
    expect(mkfifoResult.exitCode).toBe(0);
    await expectAsyncGatewayError(
      () => store.save(`${makeConfig({ port: 4444 })}\n`, initial.revision),
      'UnsafeFile',
      'The configuration lock file must be an owner-only file.',
    );
  });

  test('save() updates config with matching revision and throws StaleRevision on mismatch', async () => {
    const root = await makeTempDir();
    const store = new ConfigStore(join(root, 'mcp.json'));
    const initial = await store.initialize(async () => ({ port: 3333, token: GW_TOKEN }));

    // Saving identical content returns the same revision.
    const unchanged = await store.save(initial.text, initial.revision);
    expect(unchanged).toEqual(initial);

    // Saving updated content with matching revision writes to disk and returns a new revision.
    const updatedText = `${makeConfig({ port: 4444 })}\n`;
    const saved = await store.save(updatedText, initial.revision);
    expect(saved.text).toBe(updatedText);
    expect(saved.revision).not.toBe(initial.revision);
    expect((await store.read()).revision).toBe(saved.revision);

    // Saving with the stale revision is rejected.
    await expectAsyncGatewayError(
      () => store.save(`${makeConfig({ port: 5555 })}\n`, initial.revision),
      'StaleRevision',
      'Configuration changed on disk; reload before saving.',
    );
  });

  test('save() throws ConfigLocked when another open descriptor holds an exclusive flock on mcp.json.lock', async () => {
    const root = await makeTempDir();
    const jsonPath = join(root, 'mcp.json');
    const store = new ConfigStore(jsonPath);
    const initial = await store.initialize(async () => ({ port: 3333, token: GW_TOKEN }));
    const updatedText = `${makeConfig({ port: 4567 })}\n`;

    const lockPath = `${jsonPath}.lock`;
    const lockHandle = await fs.open(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      expect(libSystem.symbols.flock(lockHandle.fd, LOCK_EX_NB)).toBe(0);
      await expectAsyncGatewayError(
        () => store.save(updatedText, initial.revision),
        'ConfigLocked',
        'Configuration is locked by another running writer. If mcp.json.lock beside the configuration is stale, quit every app instance and confirm no writer is active before removing it and retrying.',
      );
    } finally {
      await lockHandle.close();
    }

    // After closing the competing lock descriptor, saving succeeds.
    const saved = await store.save(updatedText, initial.revision);
    expect(saved.text).toBe(updatedText);
  });
});
