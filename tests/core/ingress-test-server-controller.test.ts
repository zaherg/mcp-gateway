import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MODERN_VERSION } from '@mcp-gateway/core/adapter';
import { parseConfig, resolveKeys } from '@mcp-gateway/core/config';
import { McpGatewayController } from '@mcp-gateway/core/controller';
import { GatewayError } from '@mcp-gateway/core/errors';
import { GatewayIngress, tokenMatches } from '@mcp-gateway/core/ingress';
import { LogBuffer } from '@mcp-gateway/core/logs';
import { checkEndpoint } from '@mcp-gateway/core/test-server';
import { isRecord } from '@mcp-gateway/shared/config-document';
import type {
  GatewayConfig,
  GatewayErrorCode,
  KeyStore,
  VisibleError,
} from '@mcp-gateway/shared/types';

const GLOBAL_TOKEN = 'global-ingress-test-token-0123456789abcdef';
const BETA_TOKEN = 'beta-override-test-token-fedcba9876543210';

const activeControllers: McpGatewayController[] = [];
const activeIngresses: GatewayIngress[] = [];
const activeServers: Server[] = [];
const tempDirs: string[] = [];

const listenHttp = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Expected a TCP listener.'));
      else resolve(address.port);
    });
  });

const closeHttp = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
};

const reservePort = async (): Promise<number> => {
  const reservation = createServer();
  try {
    return await listenHttp(reservation);
  } finally {
    await closeHttp(reservation);
  }
};

const createTempConfigPath = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bear-mcp-t056-03-'));
  tempDirs.push(dir);
  return join(dir, 'mcp.json');
};

const createMemoryKeyStore = (options?: {
  failSet?: boolean;
}): { store: KeyStore; entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  const store: KeyStore = {
    get: async (refs) => {
      const result = new Map<string, string>();
      for (const ref of refs) {
        const value = entries.get(ref);
        if (value !== undefined) result.set(ref, value);
      }
      return result;
    },
    set: async (ref, value) => {
      if (options?.failSet) throw new Error('Keychain access denied.');
      entries.set(ref, value);
    },
  };
  return { store, entries };
};

const readBodyJson = async (req: IncomingMessage): Promise<unknown> => {
  let text = '';
  for await (const chunk of req) text += chunk.toString();
  return text ? JSON.parse(text) : null;
};

const startMockServer = async (
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<number> => {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  activeServers.push(server);
  return listenHttp(server);
};

const startModernMcpUpstream = async (): Promise<number> =>
  startMockServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const message = await readBodyJson(req);
    if (!isRecord(message)) {
      res.writeHead(400).end();
      return;
    }
    if (message.method === 'server/discover') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            supportedVersions: [MODERN_VERSION],
            serverInfo: { name: 'modern-fixture', version: '1.0.0' },
            capabilities: {},
          },
        }),
      );
      return;
    }
    if (message.method === 'ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32601, message: 'Method not found' },
      }),
    );
  });

const expectAsyncGatewayError = async (
  fn: () => Promise<unknown>,
  code: GatewayErrorCode,
  message?: string,
): Promise<GatewayError> => {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe(code);
    if (message !== undefined) expect(gatewayError.message).toBe(message);
    return gatewayError;
  }
  throw new Error(`Expected GatewayError(${code}) to be thrown.`);
};

interface RawHttpResponse {
  statusCode: number;
  statusLine: string;
  headers: Record<string, string>;
  body: string;
}

const sendRawHttp = (port: number, requestText: string): Promise<RawHttpResponse> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const boundary = raw.indexOf('\r\n\r\n');
      const head = boundary >= 0 ? raw.slice(0, boundary) : raw;
      const body = boundary >= 0 ? raw.slice(boundary + 4) : '';
      const lines = head.split('\r\n');
      const statusLine = lines[0] ?? '';
      const statusCode = Number(statusLine.split(' ')[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const sep = line.indexOf(':');
        if (sep < 0) continue;
        headers[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
      }
      resolve({ statusCode, statusLine, headers, body });
    };
    const timer = setTimeout(() => finish(new Error('Raw HTTP request timed out.')), 5_000);
    socket.once('error', (error) => finish(error));
    socket.on('data', (chunk) =>
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    );
    socket.once('end', () => finish());
    socket.once('close', () => finish());
    socket.once('connect', () => {
      socket.write(requestText);
    });
  });

const buildConfig = (
  port: number,
  options?: {
    keepAwake?: boolean;
    mcpServers?: Record<string, unknown>;
  },
): GatewayConfig =>
  resolveKeys(
    parseConfig(
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          token: GLOBAL_TOKEN,
          ...(options?.keepAwake !== undefined ? { keepAwake: options.keepAwake } : {}),
        },
        mcpServers: options?.mcpServers ?? {
          alpha: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            legacyProtocol: false,
          },
          beta: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            token: BETA_TOKEN,
            legacyProtocol: true,
          },
          gamma: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            disabled: true,
          },
        },
      }),
      {},
    ),
    new Map(),
  );

afterEach(async () => {
  await Promise.all([
    ...activeControllers.splice(0).map((controller) => controller.close().catch(() => undefined)),
    ...activeIngresses.splice(0).map((ingress) => ingress.close().catch(() => undefined)),
    ...activeServers.splice(0).map((server) => closeHttp(server).catch(() => undefined)),
  ]);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('tokenMatches', () => {
  test('returns true only when expected is non-empty and matches actual exactly', () => {
    expect(tokenMatches(GLOBAL_TOKEN, GLOBAL_TOKEN)).toBe(true);
    expect(tokenMatches('a', 'a')).toBe(true);
  });

  test('returns false for empty, undefined, or mismatched tokens', () => {
    expect(tokenMatches('', GLOBAL_TOKEN)).toBe(false);
    expect(tokenMatches(GLOBAL_TOKEN, undefined)).toBe(false);
    expect(tokenMatches(GLOBAL_TOKEN, '')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('', undefined)).toBe(false);
    expect(tokenMatches(`${GLOBAL_TOKEN}x`, GLOBAL_TOKEN)).toBe(false);
    expect(tokenMatches(GLOBAL_TOKEN.slice(0, -1), GLOBAL_TOKEN)).toBe(false);
    expect(tokenMatches('secret-token-1', 'secret-token-2')).toBe(false);
    expect(tokenMatches('Secret-Token', 'secret-token')).toBe(false);
  });
});

describe('GatewayIngress admission guards and lifecycle', () => {
  test('enforces security headers, auth, per-server token overrides, host/origin, routes, methods, media types, and body limits', async () => {
    const port = await reservePort();
    const errors: VisibleError[] = [];
    const ingress = await GatewayIngress.open(buildConfig(port), (error) => errors.push(error));
    activeIngresses.push(ingress);

    expect(ingress.running).toBe(true);
    expect(ingress.address).toBe(`http://127.0.0.1:${port}`);

    const assertSecurityHeaders = (headers: Headers | Record<string, string>) => {
      const get = (name: string) =>
        headers instanceof Headers ? headers.get(name) : (headers[name.toLowerCase()] ?? null);
      expect(get('cache-control')).toBe('no-store');
      expect(get('x-content-type-options')).toBe('nosniff');
      expect(get('access-control-allow-origin')).toBeNull();
    };

    // 401 when Authorization is missing, non-Bearer, wrong, or uses global token on beta
    const missingAuth = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, { method: 'POST' });
    expect(missingAuth.status).toBe(401);
    expect(missingAuth.headers.get('www-authenticate')).toBe('Bearer');
    assertSecurityHeaders(missingAuth.headers);

    const basicAuth = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: 'POST',
      headers: { authorization: `Basic ${GLOBAL_TOKEN}` },
    });
    expect(basicAuth.status).toBe(401);
    expect(basicAuth.headers.get('www-authenticate')).toBe('Bearer');

    const globalOnBeta = await fetch(`http://127.0.0.1:${port}/mcp/beta`, {
      method: 'POST',
      headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
    });
    expect(globalOnBeta.status).toBe(401);
    expect(globalOnBeta.headers.get('www-authenticate')).toBe('Bearer');

    const betaOnAlpha = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BETA_TOKEN}` },
    });
    expect(betaOnAlpha.status).toBe(401);
    expect(betaOnAlpha.headers.get('www-authenticate')).toBe('Bearer');

    // 403 on DNS-rebinding Host header and foreign Origin header
    const badHost = await sendRawHttp(
      port,
      [
        'POST /mcp/alpha HTTP/1.1',
        'Host: evil.example.com',
        `Authorization: Bearer ${GLOBAL_TOKEN}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    expect(badHost.statusCode).toBe(403);
    assertSecurityHeaders(badHost.headers);

    const badOrigin = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GLOBAL_TOKEN}`,
        origin: 'http://evil.example.com',
      },
    });
    expect(badOrigin.status).toBe(403);
    assertSecurityHeaders(badOrigin.headers);

    // HTTP upgrade rejections: 403 on bad Host/Origin, 405 on valid Host
    const upgradeBadHost = await sendRawHttp(
      port,
      [
        'GET /mcp/alpha HTTP/1.1',
        'Host: evil.example.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'),
    );
    expect(upgradeBadHost.statusCode).toBe(403);

    const upgradeBadOrigin = await sendRawHttp(
      port,
      [
        'GET /mcp/alpha HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Origin: http://evil.example.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'),
    );
    expect(upgradeBadOrigin.statusCode).toBe(403);

    const upgradeValidHost = await sendRawHttp(
      port,
      [
        'GET /mcp/alpha HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'),
    );
    expect(upgradeValidHost.statusCode).toBe(405);

    // 404 for unknown routes, disabled servers, and unsafe route names
    for (const path of ['/mcp/unknown', '/other', '/mcp/gamma', '/mcp/bad/name']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
      });
      expect(res.status).toBe(404);
      assertSecurityHeaders(res.headers);
    }

    // 405 with Allow: POST on stateless alpha vs Allow: POST, GET, DELETE on session-based beta
    const getAlpha = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: 'GET',
      headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
    });
    expect(getAlpha.status).toBe(405);
    expect(getAlpha.headers.get('allow')).toBe('POST');
    assertSecurityHeaders(getAlpha.headers);

    const patchBeta = await fetch(`http://127.0.0.1:${port}/mcp/beta`, {
      method: 'PATCH',
      headers: { authorization: `bearer ${BETA_TOKEN}` },
    });
    expect(patchBeta.status).toBe(405);
    expect(patchBeta.headers.get('allow')).toBe('POST, GET, DELETE');
    assertSecurityHeaders(patchBeta.headers);

    // 415 on Content-Encoding: gzip and on Content-Type: text/plain
    const gzipReq = await sendRawHttp(
      port,
      [
        'POST /mcp/alpha HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${GLOBAL_TOKEN}`,
        'Content-Encoding: gzip',
        'Content-Type: application/json',
        'Content-Length: 2',
        'Connection: close',
        '',
        '{}',
      ].join('\r\n'),
    );
    expect(gzipReq.statusCode).toBe(415);
    assertSecurityHeaders(gzipReq.headers);

    const textPlainReq = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GLOBAL_TOKEN}`,
        'content-type': 'text/plain',
      },
      body: 'hello',
    });
    expect(textPlainReq.status).toBe(415);
    assertSecurityHeaders(textPlainReq.headers);

    // 400 on GET /mcp/beta with non-zero Content-Length or Transfer-Encoding
    const getWithLength = await sendRawHttp(
      port,
      [
        'GET /mcp/beta HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${BETA_TOKEN}`,
        'Content-Length: 5',
        'Connection: close',
        '',
        'hello',
      ].join('\r\n'),
    );
    expect(getWithLength.statusCode).toBe(400);
    assertSecurityHeaders(getWithLength.headers);

    const getWithChunked = await sendRawHttp(
      port,
      [
        'GET /mcp/beta HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${BETA_TOKEN}`,
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '0\r\n\r\n',
      ].join('\r\n'),
    );
    expect(getWithChunked.statusCode).toBe(400);

    // 413 on Content-Length exceeding 4 MiB
    const oversizedLength = 4 * 1024 * 1024 + 1;
    const tooLarge = await sendRawHttp(
      port,
      [
        'POST /mcp/alpha HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${GLOBAL_TOKEN}`,
        'Content-Type: application/json',
        `Content-Length: ${oversizedLength}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    expect(tooLarge.statusCode).toBe(413);
    assertSecurityHeaders(tooLarge.headers);

    expect(errors).toEqual([]);
  });

  test('reconcile updates endpoints, toggles keepAwake sleep assertion, and restart validates enabled servers', async () => {
    const port = await reservePort();
    const errors: VisibleError[] = [];
    const logs = new LogBuffer();
    let acquired = 0;
    let released = 0;
    const preventIdleSleep = () => {
      acquired++;
      let done = false;
      return () => {
        if (done) throw new Error('Sleep assertion released twice.');
        done = true;
        released++;
      };
    };

    const initialConfig = buildConfig(port, { keepAwake: false });
    const ingress = await GatewayIngress.open(
      initialConfig,
      (error) => errors.push(error),
      logs,
      undefined,
      undefined,
      preventIdleSleep,
    );
    activeIngresses.push(ingress);

    expect(acquired).toBe(0);
    expect(released).toBe(0);
    expect(ingress.snapshots().map((s) => [s.name, s.status])).toEqual([
      ['alpha', 'mounted'],
      ['beta', 'mounted'],
      ['gamma', 'disabled'],
    ]);

    // Turn on keepAwake, disable alpha, and add delta
    const updatedConfig = buildConfig(port, {
      keepAwake: true,
      mcpServers: {
        alpha: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          disabled: true,
        },
        beta: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          token: BETA_TOKEN,
          legacyProtocol: true,
        },
        delta: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
      },
    });
    await ingress.reconcile(updatedConfig);

    expect(acquired).toBe(1);
    expect(released).toBe(0);
    expect(ingress.snapshots().map((s) => [s.name, s.status])).toEqual([
      ['alpha', 'disabled'],
      ['beta', 'mounted'],
      ['delta', 'mounted'],
    ]);

    // Disabled alpha now returns 404; newly mounted delta is active (GET -> 405)
    const alphaRes = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: 'GET',
      headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
    });
    expect(alphaRes.status).toBe(404);

    const deltaRes = await fetch(`http://127.0.0.1:${port}/mcp/delta`, {
      method: 'GET',
      headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
    });
    expect(deltaRes.status).toBe(405);
    expect(deltaRes.headers.get('allow')).toBe('POST');

    // Reconciling again with keepAwake still true does not re-acquire
    await ingress.reconcile(updatedConfig);
    expect(acquired).toBe(1);
    expect(released).toBe(0);

    // Turning keepAwake off releases the assertion
    const sleepOffConfig = buildConfig(port, {
      keepAwake: false,
      mcpServers: updatedConfig.mcpServers,
    });
    await ingress.reconcile(sleepOffConfig);
    expect(acquired).toBe(1);
    expect(released).toBe(1);

    // Restart succeeds for enabled server, rejects for disabled or unknown server
    await ingress.restart('delta');
    await expectAsyncGatewayError(
      () => ingress.restart('alpha'),
      'BackendFailure',
      'Select an enabled configured server to restart.',
    );
    await expectAsyncGatewayError(
      () => ingress.restart('missing'),
      'BackendFailure',
      'Select an enabled configured server to restart.',
    );

    // Turning keepAwake back on and closing releases the assertion on close
    await ingress.reconcile(updatedConfig);
    expect(acquired).toBe(2);
    expect(released).toBe(1);

    await ingress.close();
    expect(ingress.running).toBe(false);
    expect(released).toBe(2);

    await expectAsyncGatewayError(
      () => ingress.reconcile(updatedConfig),
      'Closed',
      'The listener is closed.',
    );
    expect(errors).toEqual([]);
  });
});

describe('checkEndpoint', () => {
  test('rejects link-local/cloud-metadata url or server.url and invalid upstream URLs', async () => {
    const controller = new AbortController();

    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL('http://169.254.169.254/mcp'),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath },
          stopped: controller.signal,
        }),
      'NetworkPolicy',
      'Link-local and cloud metadata upstream addresses are not allowed.',
    );

    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL('http://127.0.0.1:41234/mcp/cloud'),
          token: GLOBAL_TOKEN,
          server: { url: 'http://169.254.169.254/mcp' },
          stopped: controller.signal,
        }),
      'NetworkPolicy',
      'Link-local and cloud metadata upstream addresses are not allowed.',
    );

    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL('http://127.0.0.1:41234/mcp/bad'),
          token: GLOBAL_TOKEN,
          server: { url: 'not-a-url' },
          stopped: controller.signal,
        }),
      'InvalidConfig',
      'An upstream URL is invalid.',
    );
  });

  test('succeeds against a live 2026-07-28 endpoint and a legacy 2025-03-26 session endpoint', async () => {
    const seenAuth: string[] = [];
    const modernPort = await startMockServer(async (req, res) => {
      seenAuth.push(req.headers.authorization ?? '');
      const message = await readBodyJson(req);
      if (isRecord(message) && message.method === 'server/discover') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              supportedVersions: [MODERN_VERSION],
              serverInfo: { name: 'modern-test', version: '1.0.0' },
              capabilities: {},
            },
          }),
        );
        return;
      }
      res.writeHead(400).end();
    });

    const modernResult = await checkEndpoint({
      url: new URL(`http://127.0.0.1:${modernPort}/mcp/modern`),
      token: GLOBAL_TOKEN,
      server: { url: `http://127.0.0.1:${modernPort}/upstream`, legacyProtocol: false },
      stopped: new AbortController().signal,
    });
    expect(modernResult).toEqual({ protocolVersion: MODERN_VERSION });
    expect(seenAuth).toEqual([`Bearer ${GLOBAL_TOKEN}`]);

    let terminatedSession = false;
    const legacyPort = await startMockServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'DELETE') {
        if (req.headers['mcp-session-id'] === 'session-legacy-1') terminatedSession = true;
        res.writeHead(204).end();
        return;
      }
      const message = await readBodyJson(req);
      if (isRecord(message) && message.method === 'initialize') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'session-legacy-1',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'legacy-test', version: '1.0.0' },
            },
          }),
        );
        return;
      }
      if (isRecord(message) && message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(400).end();
    });

    const legacyResult = await checkEndpoint({
      url: new URL(`http://127.0.0.1:${legacyPort}/mcp/legacy`),
      token: BETA_TOKEN,
      server: { command: process.execPath, legacyProtocol: true },
      stopped: new AbortController().signal,
    });
    expect(legacyResult).toEqual({ protocolVersion: '2025-03-26' });
    expect(terminatedSession).toBe(true);
  });

  test('explains -32601, -32603 (missing binary vs existing binary vs http), gateway HTTP refusals, and pre-aborted signals', async () => {
    // -32601 METHOD_NOT_FOUND when legacyProtocol: false
    const methodNotFoundPort = await startMockServer(async (req, res) => {
      const message = await readBodyJson(req);
      const id = isRecord(message) ? (message.id ?? null) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Method not found' },
        }),
      );
    });

    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${methodNotFoundPort}/mcp/old`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath, legacyProtocol: false },
          stopped: new AbortController().signal,
        }),
      'BackendFailure',
      'The server does not support MCP 2026-07-28. Turn on Allow session-based clients, save, and test again.',
    );

    // -32603 PROCESS_FAILED through a live GatewayIngress for missing binary vs existing binary
    const gatewayPort = await reservePort();
    const errors: VisibleError[] = [];
    const ingress = await GatewayIngress.open(
      buildConfig(gatewayPort, {
        mcpServers: {
          missingBin: {
            command: 'definitely-not-a-real-binary-t056-03',
            args: [],
            legacyProtocol: false,
          },
          exitsImmediately: {
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
            legacyProtocol: false,
          },
        },
      }),
      (error) => errors.push(error),
    );
    activeIngresses.push(ingress);

    await expectAsyncGatewayError(
      () => ingress.testServer('missingBin'),
      'BackendFailure',
      'The gateway could not find the program in Command. Enter its full path (run command -v <name> in Terminal), save, and test again.',
    );

    await expectAsyncGatewayError(
      () => ingress.testServer('exitsImmediately'),
      'BackendFailure',
      "The server stopped before it answered. If Command starts another program, add that program's folder to PATH in Environment, save, and test again. See Logs.",
    );

    // -32603 PROCESS_FAILED on an HTTP server entry
    const processFailedPort = await startMockServer(async (req, res) => {
      const message = await readBodyJson(req);
      const id = isRecord(message) ? (message.id ?? null) : null;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: 'Upstream failed' },
        }),
      );
    });

    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${processFailedPort}/mcp/remote`),
          token: GLOBAL_TOKEN,
          server: { url: `http://127.0.0.1:${processFailedPort}/upstream` },
          stopped: new AbortController().signal,
        }),
      'BackendFailure',
      'The upstream server did not answer. Check Upstream URL and Headers. See Logs.',
    );

    // Gateway HTTP refusals (401 and 403)
    const refusal401Port = await startMockServer((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
    });
    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${refusal401Port}/mcp/auth`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath },
          stopped: new AbortController().signal,
        }),
      'ListenerFailure',
      'The gateway refused the test (HTTP 401).',
    );

    const refusal403Port = await startMockServer((_req, res) => {
      res.writeHead(403).end();
    });
    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${refusal403Port}/mcp/peer`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath },
          stopped: new AbortController().signal,
        }),
      'ListenerFailure',
      'The gateway refused this Mac (HTTP 403). Check Allowed client ranges.',
    );

    // Pre-aborted stopped signal reports Cancelled
    const aborted = new AbortController();
    aborted.abort();
    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${methodNotFoundPort}/mcp/cancelled`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath },
          stopped: aborted.signal,
        }),
      'Cancelled',
      'The test stopped because the gateway or this server changed.',
    );
  });
});

describe('McpGatewayController lifecycle and invariants', () => {
  test('open initializes mcp.json with plaintext token, with KeyStore tokenRef, or records KeySetupFailed', async () => {
    // Plaintext initialization when no KeyStore is provided
    const plainPath = await createTempConfigPath();
    const plainPort = await reservePort();
    const plainController = await McpGatewayController.open(
      plainPath,
      undefined,
      undefined,
      plainPort,
    );
    activeControllers.push(plainController);

    const plainSnap = plainController.snapshot();
    expect(plainSnap.configError).toBeNull();
    expect(plainSnap.running).toBe(false);
    expect(plainSnap.keyMigration).toEqual({ gateway: false, servers: [] });
    const plainOnDisk = JSON.parse(await fs.readFile(plainPath, 'utf8')) as {
      gateway: { port: number; token?: string; tokenRef?: string };
    };
    expect(plainOnDisk.gateway.port).toBe(plainPort);
    expect(typeof plainOnDisk.gateway.token).toBe('string');
    expect(plainOnDisk.gateway.tokenRef).toBeUndefined();
    expect(plainController.activeConfig()?.gateway.token).toBe(plainOnDisk.gateway.token);

    // KeyStore initialization writes tokenRef and stores secret in KeyStore
    const keyPath = await createTempConfigPath();
    const keyPort = await reservePort();
    const { store, entries } = createMemoryKeyStore();
    const keyController = await McpGatewayController.open(keyPath, undefined, store, keyPort);
    activeControllers.push(keyController);

    const keySnap = keyController.snapshot();
    expect(keySnap.configError).toBeNull();
    expect(keySnap.keyMigration).toEqual({ gateway: false, servers: [] });
    const keyOnDisk = JSON.parse(await fs.readFile(keyPath, 'utf8')) as {
      gateway: { token?: string; tokenRef?: string };
    };
    expect(keyOnDisk.gateway.token).toBeUndefined();
    expect(typeof keyOnDisk.gateway.tokenRef).toBe('string');
    const ref = keyOnDisk.gateway.tokenRef as string;
    expect(entries.has(ref)).toBe(true);
    expect(keyController.activeConfig()?.gateway.token).toBe(entries.get(ref));

    // Failing KeyStore.set records KeySetupFailed and blocks saveConfig
    const failPath = await createTempConfigPath();
    const failPort = await reservePort();
    const failingStore = createMemoryKeyStore({ failSet: true }).store;
    const failController = await McpGatewayController.open(
      failPath,
      undefined,
      failingStore,
      failPort,
    );
    activeControllers.push(failController);

    const failSnap = failController.snapshot();
    expect(failSnap.configError?.code).toBe('KeySetupFailed');
    expect(failSnap.running).toBe(false);
    await expectAsyncGatewayError(
      () => failController.saveConfig('{}', failSnap.revision),
      'KeySetupFailed',
    );
  });

  test('supports autoStart, start, testServer, restartServer, readLogs/clearLogs, and stop', async () => {
    const upstreamPort = await startModernMcpUpstream();
    const port = await reservePort();
    const configPath = await createTempConfigPath();
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          token: GLOBAL_TOKEN,
          autoStart: true,
        },
        mcpServers: {
          modern: {
            url: `http://127.0.0.1:${upstreamPort}/mcp`,
          },
          off: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            disabled: true,
          },
        },
      }),
      { mode: 0o600 },
    );

    const controller = await McpGatewayController.open(configPath, undefined, undefined, port);
    activeControllers.push(controller);

    const autoStarted = controller.snapshot();
    expect(autoStarted.running).toBe(true);
    expect(autoStarted.configError).toBeNull();
    expect(autoStarted.servers.map((s) => [s.name, s.status])).toEqual([
      ['modern', 'mounted'],
      ['off', 'disabled'],
    ]);

    // testServer validates mounted server and rejects stale revision
    const check = await controller.testServer('modern', autoStarted.revision);
    expect(check).toEqual({ protocolVersion: MODERN_VERSION });

    await expectAsyncGatewayError(
      () => controller.testServer('modern', 'stale-revision'),
      'StaleRevision',
    );

    // restartServer restarts enabled server and rejects disabled/unknown server
    const restarted = await controller.restartServer('modern');
    expect(restarted.running).toBe(true);
    await expectAsyncGatewayError(() => controller.restartServer('off'), 'BackendFailure');

    // readLogs and clearLogs
    const initialLogs = controller.readLogs({ after: 0 });
    expect(initialLogs.entries.length).toBeGreaterThan(0);
    const cleared = controller.clearLogs();
    expect(cleared.entries).toEqual([]);
    expect(cleared.generation).toBeGreaterThan(initialLogs.generation);

    // stop stops the listener; start restarts it cleanly
    const stopped = await controller.stop();
    expect(stopped.running).toBe(false);
    await expectAsyncGatewayError(
      () => controller.testServer('modern', stopped.revision),
      'Closed',
    );

    const startedAgain = await controller.start();
    expect(startedAgain.running).toBe(true);
    expect(await controller.testServer('modern', startedAgain.revision)).toEqual({
      protocolVersion: MODERN_VERSION,
    });
  });

  test('cancels queued start and saveConfig at dequeue when stop runs first (Plan 040)', async () => {
    const port = await reservePort();
    const configPath = await createTempConfigPath();
    const controller = await McpGatewayController.open(configPath, undefined, undefined, port);
    activeControllers.push(controller);

    const before = controller.snapshot();
    const diskBefore = await fs.readFile(configPath, 'utf8');
    expect(before.running).toBe(false);

    const op = controller.operation();
    await controller.stop();

    await expectAsyncGatewayError(
      () => controller.start(op),
      'Cancelled',
      'The request was cancelled because the gateway stopped.',
    );
    expect(controller.snapshot().running).toBe(false);

    const nextText = JSON.stringify({
      gateway: { host: '127.0.0.1', port, token: BETA_TOKEN },
      mcpServers: {},
    });
    await expectAsyncGatewayError(
      () => controller.saveConfig(nextText, before.revision, op),
      'Cancelled',
      'The request was cancelled because the gateway stopped.',
    );

    expect(controller.snapshot().revision).toBe(before.revision);
    expect(await fs.readFile(configPath, 'utf8')).toBe(diskBefore);
  });

  test('saveConfig resolves with written file and records ListenerFailure when applying new port fails (Plan 041)', async () => {
    const initialPort = await reservePort();
    const busyPort = await startMockServer((_req, res) => {
      res.writeHead(200).end();
    });
    const configPath = await createTempConfigPath();
    const controller = await McpGatewayController.open(
      configPath,
      undefined,
      undefined,
      initialPort,
    );
    activeControllers.push(controller);

    const started = await controller.start();
    expect(started.running).toBe(true);

    const nextText = JSON.stringify(
      {
        gateway: {
          host: '127.0.0.1',
          port: busyPort,
          token: GLOBAL_TOKEN,
        },
        mcpServers: {},
      },
      null,
      2,
    );

    // Stale revision must be refused before writing
    await expectAsyncGatewayError(
      () => controller.saveConfig(nextText, 'wrong-revision'),
      'StaleRevision',
    );

    const saved = await controller.saveConfig(nextText, started.revision);
    expect(saved.revision).not.toBe(started.revision);
    expect(saved.configText).toBe(nextText);
    expect(saved.running).toBe(false);
    expect(saved.operationalError?.code).toBe('ListenerFailure');
    expect(await fs.readFile(configPath, 'utf8')).toBe(nextText);
  });

  test('migrateKeys moves literal gateway and server tokens into KeyStore while keeping listener running (Plan 029)', async () => {
    const port = await reservePort();
    const configPath = await createTempConfigPath();
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          gateway: {
            host: '127.0.0.1',
            port,
            token: GLOBAL_TOKEN,
          },
          mcpServers: {
            alpha: {
              command: process.execPath,
              args: ['-e', 'process.exit(0)'],
              token: BETA_TOKEN,
            },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const { store, entries } = createMemoryKeyStore();
    const controller = await McpGatewayController.open(configPath, undefined, store, port);
    activeControllers.push(controller);

    const started = await controller.start();
    expect(started.running).toBe(true);
    expect(started.keyMigration).toEqual({ gateway: true, servers: ['alpha'] });

    const migrated = await controller.migrateKeys(
      { gateway: true, servers: ['alpha'] },
      started.revision,
    );
    expect(migrated.running).toBe(true);
    expect(migrated.revision).not.toBe(started.revision);
    expect(migrated.keyMigration).toEqual({ gateway: false, servers: [] });

    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      gateway: { token?: string; tokenRef?: string };
      mcpServers: { alpha: { token?: string; tokenRef?: string } };
    };
    expect(onDisk.gateway.token).toBeUndefined();
    expect(typeof onDisk.gateway.tokenRef).toBe('string');
    expect(entries.get(onDisk.gateway.tokenRef as string)).toBe(GLOBAL_TOKEN);

    expect(onDisk.mcpServers.alpha.token).toBeUndefined();
    expect(typeof onDisk.mcpServers.alpha.tokenRef).toBe('string');
    expect(entries.get(onDisk.mcpServers.alpha.tokenRef as string)).toBe(BETA_TOKEN);

    // Active resolved config still retains the exact tokens
    expect(controller.activeConfig()?.gateway.token).toBe(GLOBAL_TOKEN);
    expect(controller.activeConfig()?.mcpServers.alpha?.token).toBe(BETA_TOKEN);

    // Attempting to migrate already-migrated slots rejects with InvalidConfig
    await expectAsyncGatewayError(
      () => controller.migrateKeys({ gateway: true, servers: [] }, migrated.revision),
      'InvalidConfig',
    );
  });
});
