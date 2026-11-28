import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { MODERN_VERSION } from '@mcp-gateway/core/adapter';
import { parseConfig, resolveKeys } from '@mcp-gateway/core/config';
import { McpGatewayController } from '@mcp-gateway/core/controller';
import { GatewayIngress, tokenMatches } from '@mcp-gateway/core/ingress';
import { LogBuffer } from '@mcp-gateway/core/logs';
import { checkEndpoint } from '@mcp-gateway/core/test-server';
import { isRecord } from '@mcp-gateway/shared/config-document';
import type { KeyStore, VisibleError } from '@mcp-gateway/shared/types';
import {
  deferred,
  expectAsyncGatewayError,
  expectGatewayError,
  registerTempDirLifecycle,
} from '../helpers/core';
import { closeServer, listen } from '../helpers/http-mount';

const GLOBAL_TOKEN = 'global-ingress-test-token-0123456789abcdef';
const BETA_TOKEN = 'beta-override-test-token-fedcba9876543210';

const activeControllers: McpGatewayController[] = [];
const activeIngresses: GatewayIngress[] = [];
const activeServers: Server[] = [];
const { makeTempDir } = registerTempDirLifecycle('bear-mcp-t060-02-');

const reservePort = async () => {
  const reservation = createServer();
  try {
    return await listen(reservation);
  } finally {
    await closeServer(reservation);
  }
};

const createTempConfigPath = async () => {
  const dir = await makeTempDir();
  return join(dir, 'mcp.json');
};

const waitFor = async (predicate: () => boolean, description: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for: ${description}`);
};

const createMemoryKeyStore = (options?: { failSet?: boolean; mismatchGet?: boolean }) => {
  const entries = new Map<string, string>();
  const store: KeyStore = {
    get: async (refs) => {
      const result = new Map<string, string>();
      for (const ref of refs) {
        const value = entries.get(ref);
        if (value !== undefined) {
          result.set(ref, options?.mismatchGet ? `${value}-corrupted` : value);
        }
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
) => {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  activeServers.push(server);
  return listen(server);
};

const startModernMcpUpstream = async () =>
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
) =>
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
    ...activeServers.splice(0).map((server) => closeServer(server).catch(() => undefined)),
  ]);
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

    const fetchCases: Array<{
      label: string;
      path: string;
      method: string;
      headers?: Record<string, string>;
      body?: string;
      status: number;
      wwwAuthenticate?: string;
      allow?: string;
    }> = [
      {
        label: 'missing Authorization header',
        path: '/mcp/alpha',
        method: 'POST',
        status: 401,
        wwwAuthenticate: 'Bearer',
      },
      {
        label: 'non-Bearer Authorization header',
        path: '/mcp/alpha',
        method: 'POST',
        headers: { authorization: `Basic ${GLOBAL_TOKEN}` },
        status: 401,
        wwwAuthenticate: 'Bearer',
      },
      {
        label: 'global token rejected on server with token override',
        path: '/mcp/beta',
        method: 'POST',
        headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
        status: 401,
        wwwAuthenticate: 'Bearer',
      },
      {
        label: 'server override token rejected on global server',
        path: '/mcp/alpha',
        method: 'POST',
        headers: { authorization: `Bearer ${BETA_TOKEN}` },
        status: 401,
        wwwAuthenticate: 'Bearer',
      },
      {
        label: 'foreign Origin header rejected with 403',
        path: '/mcp/alpha',
        method: 'POST',
        headers: {
          authorization: `Bearer ${GLOBAL_TOKEN}`,
          origin: 'http://evil.example.com',
        },
        status: 403,
      },
      {
        label: 'unknown server route returns 404',
        path: '/mcp/unknown',
        method: 'POST',
        headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
        status: 404,
      },
      {
        label: 'non-MCP route returns 404',
        path: '/other',
        method: 'POST',
        headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
        status: 404,
      },
      {
        label: 'disabled server returns 404',
        path: '/mcp/gamma',
        method: 'POST',
        headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
        status: 404,
      },
      {
        label: 'unsafe route name returns 404',
        path: '/mcp/bad/name',
        method: 'POST',
        headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
        status: 404,
      },
      {
        label: 'GET on stateless endpoint returns 405 Allow: POST',
        path: '/mcp/alpha',
        method: 'GET',
        headers: { authorization: `Bearer ${GLOBAL_TOKEN}` },
        status: 405,
        allow: 'POST',
      },
      {
        label: 'PATCH on session endpoint returns 405 Allow: POST, GET, DELETE',
        path: '/mcp/beta',
        method: 'PATCH',
        headers: { authorization: `bearer ${BETA_TOKEN}` },
        status: 405,
        allow: 'POST, GET, DELETE',
      },
      {
        label: 'non-JSON Content-Type returns 415',
        path: '/mcp/alpha',
        method: 'POST',
        headers: {
          authorization: `Bearer ${GLOBAL_TOKEN}`,
          'content-type': 'text/plain',
        },
        body: 'hello',
        status: 415,
      },
    ];

    for (const tc of fetchCases) {
      const res = await fetch(`http://127.0.0.1:${port}${tc.path}`, {
        method: tc.method,
        headers: tc.headers,
        body: tc.body,
      });
      expect(res.status).toBe(tc.status);
      if (tc.wwwAuthenticate) expect(res.headers.get('www-authenticate')).toBe(tc.wwwAuthenticate);
      if (tc.allow) expect(res.headers.get('allow')).toBe(tc.allow);
      assertSecurityHeaders(res.headers);
    }

    const oversizedLength = 4 * 1024 * 1024 + 1;
    const rawCases: Array<{
      label: string;
      lines: string[];
      status: number;
      checkSecurityHeaders?: boolean;
    }> = [
      {
        label: 'DNS-rebinding Host header rejected with 403',
        lines: [
          'POST /mcp/alpha HTTP/1.1',
          'Host: evil.example.com',
          `Authorization: Bearer ${GLOBAL_TOKEN}`,
          'Connection: close',
          '',
          '',
        ],
        status: 403,
        checkSecurityHeaders: true,
      },
      {
        label: 'HTTP upgrade with mismatched Host rejected with 403',
        lines: [
          'GET /mcp/alpha HTTP/1.1',
          'Host: evil.example.com',
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ],
        status: 403,
      },
      {
        label: 'HTTP upgrade with foreign Origin rejected with 403',
        lines: [
          'GET /mcp/alpha HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Origin: http://evil.example.com',
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ],
        status: 403,
      },
      {
        label: 'HTTP upgrade with valid Host rejected with 405',
        lines: [
          'GET /mcp/alpha HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ],
        status: 405,
      },
      {
        label: 'Content-Encoding: gzip rejected with 415',
        lines: [
          'POST /mcp/alpha HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${GLOBAL_TOKEN}`,
          'Content-Encoding: gzip',
          'Content-Type: application/json',
          'Content-Length: 2',
          'Connection: close',
          '',
          '{}',
        ],
        status: 415,
        checkSecurityHeaders: true,
      },
      {
        label: 'GET with non-zero Content-Length rejected with 400',
        lines: [
          'GET /mcp/beta HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${BETA_TOKEN}`,
          'Content-Length: 5',
          'Connection: close',
          '',
          'hello',
        ],
        status: 400,
        checkSecurityHeaders: true,
      },
      {
        label: 'GET with Transfer-Encoding: chunked rejected with 400',
        lines: [
          'GET /mcp/beta HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${BETA_TOKEN}`,
          'Transfer-Encoding: chunked',
          'Connection: close',
          '',
          '0\r\n\r\n',
        ],
        status: 400,
      },
      {
        label: 'Content-Length exceeding 4 MiB rejected with 413',
        lines: [
          'POST /mcp/alpha HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${GLOBAL_TOKEN}`,
          'Content-Type: application/json',
          `Content-Length: ${oversizedLength}`,
          'Connection: close',
          '',
          '',
        ],
        status: 413,
        checkSecurityHeaders: true,
      },
    ];

    for (const tc of rawCases) {
      const rawRes = await sendRawHttp(port, tc.lines.join('\r\n'));
      expect(rawRes.statusCode).toBe(tc.status);
      if (tc.checkSecurityHeaders) assertSecurityHeaders(rawRes.headers);
    }

    expect(errors).toEqual([]);
  });

  test('enforces 32-request concurrency limit (429 on 33rd request), clientError 400 on malformed raw HTTP, and testServer guards', async () => {
    const holdGate = deferred();
    const upstreamPort = await startMockServer(async (req, res) => {
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
              serverInfo: { name: 'concurrency-fixture', version: '1.0.0' },
              capabilities: {},
            },
          }),
        );
        return;
      }
      if (message.method === 'ping') {
        await holdGate.promise;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        return;
      }
      res.writeHead(400).end();
    });

    const port = await reservePort();
    const errors: VisibleError[] = [];
    const ingress = await GatewayIngress.open(
      buildConfig(port, {
        mcpServers: {
          alpha: {
            url: `http://127.0.0.1:${upstreamPort}/mcp`,
            legacyProtocol: true,
          },
          disabledServer: {
            url: `http://127.0.0.1:${upstreamPort}/mcp`,
            disabled: true,
          },
        },
      }),
      (error) => errors.push(error),
    );
    activeIngresses.push(ingress);

    // Malformed raw HTTP triggers server.on('clientError') -> 400 Bad Request
    const malformed = await sendRawHttp(port, 'BAD HTTP\r\n\r\n');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.statusLine).toContain('400 Bad Request');

    // Sending 32 raw HTTP POST headers with Content-Length: 2 without body bytes keeps all 32 requests in readRequestBody() right after admitRequest() increments this.active to 32
    const heldSockets = await Promise.all(
      Array.from(
        { length: 32 },
        () =>
          new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port });
            socket.once('error', reject);
            socket.once('connect', () => {
              socket.write(
                [
                  'POST /mcp/alpha HTTP/1.1',
                  `Host: 127.0.0.1:${port}`,
                  `Authorization: Bearer ${GLOBAL_TOKEN}`,
                  'Content-Type: application/json',
                  'Content-Length: 2',
                  '',
                  '',
                ].join('\r\n'),
              );
              resolve(socket);
            });
          }),
      ),
    );

    try {
      await waitFor(
        () => (ingress as unknown as { active: number }).active === 32,
        '32 active requests in GatewayIngress',
      );

      // 33rd request immediately receives HTTP 429
      const overflowRes = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${GLOBAL_TOKEN}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(overflowRes.status).toBe(429);
    } finally {
      for (const socket of heldSockets) socket.destroy();
      holdGate.resolve();
    }

    await waitFor(
      () => (ingress as unknown as { active: number }).active === 0,
      'held requests to settle back to 0 active',
    );

    // Subsequent requests after releasing the 32 held slots succeed (not 429)
    const afterRelease = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GLOBAL_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(afterRelease.status).not.toBe(429);

    // ingress.testServer guards: missing or disabled server
    await expectAsyncGatewayError(
      () => ingress.testServer('missing-server'),
      'BackendFailure',
      'Start the gateway and this server, then test again.',
    );
    await expectAsyncGatewayError(
      () => ingress.testServer('disabledServer'),
      'BackendFailure',
      'Start the gateway and this server, then test again.',
    );

    // Concurrent testServer lock and mid-test abort on ingress.close()
    const checkStarted = deferred();
    const checkGate = deferred();
    const slowUpstreamPort = await startMockServer(async (_req, res) => {
      checkStarted.resolve();
      await checkGate.promise;
      if (!res.destroyed) res.writeHead(500).end();
    });

    await ingress.reconcile(
      buildConfig(port, {
        mcpServers: {
          alpha: {
            url: `http://127.0.0.1:${slowUpstreamPort}/mcp`,
            legacyProtocol: false,
          },
        },
      }),
    );

    const firstTest = ingress.testServer('alpha');
    await checkStarted.promise;

    // While one testServer is in flight, a second concurrent testServer rejects
    await expectAsyncGatewayError(
      () => ingress.testServer('alpha'),
      'BackendFailure',
      'Another server test is running.',
    );

    // Closing ingress while testServer is in flight aborts the test signal with Cancelled
    const closePromise = ingress.close();
    await expectAsyncGatewayError(
      () => firstTest,
      'Cancelled',
      'The test stopped because the gateway or this server changed.',
    );
    checkGate.resolve();
    await closePromise;
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

  test('explains -32601, -32603 (missing binary vs existing binary vs http), gateway HTTP refusals, 504 timeout, fallback handshake failures, and pre-aborted signals', async () => {
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

    // HTTP 504 timeout explanation
    const timeout504Port = await startMockServer((_req, res) => {
      res.writeHead(504).end();
    });
    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${timeout504Port}/mcp/timeout`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath },
          stopped: new AbortController().signal,
        }),
      'BackendFailure',
      'The server did not answer within 30 seconds. See Logs.',
    );

    // Fallback handshake diagnostic: HTTP 200 with unexpected JSON-RPC error -32600 (legacyProtocol: true) or non-JSON body
    const invalidRequestPort = await startMockServer(async (req, res) => {
      const message = await readBodyJson(req);
      const id = isRecord(message) ? (message.id ?? null) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'Invalid Request' },
        }),
      );
    });
    const rpcLogs = new LogBuffer();
    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${invalidRequestPort}/mcp/bad-rpc`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath, legacyProtocol: true },
          stopped: new AbortController().signal,
          onDiagnostic: (level, values) =>
            rpcLogs.append({ server: 'bad-rpc', level, source: 'controller' }, values),
        }),
      'BackendFailure',
      'The server did not complete the MCP handshake. See Logs.',
    );
    const rpcEntries = rpcLogs.read({ after: 0 }).entries;
    expect(rpcEntries).toHaveLength(1);
    expect(rpcEntries[0]?.server).toBe('bad-rpc');
    expect(rpcEntries[0]?.level).toBe('error');
    expect(rpcEntries[0]?.text).toContain('HTTP 200');
    expect(rpcEntries[0]?.text).toContain('JSON-RPC -32600: Invalid Request');

    const nonJsonPort = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('not-json');
    });
    const nonJsonLogs = new LogBuffer();
    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${nonJsonPort}/mcp/non-json`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath, legacyProtocol: false },
          stopped: new AbortController().signal,
          onDiagnostic: (level, values) =>
            nonJsonLogs.append({ server: 'non-json', level, source: 'controller' }, values),
        }),
      'BackendFailure',
      'The server did not complete the MCP handshake. See Logs.',
    );
    const nonJsonEntries = nonJsonLogs.read({ after: 0 }).entries;
    expect(nonJsonEntries).toHaveLength(1);
    expect(nonJsonEntries[0]?.text).toContain('HTTP 200, text/plain');

    // Pre-aborted stopped signal reports Cancelled without logging an error diagnostic
    const aborted = new AbortController();
    aborted.abort();
    const cancelledLogs = new LogBuffer();
    await expectAsyncGatewayError(
      () =>
        checkEndpoint({
          url: new URL(`http://127.0.0.1:${methodNotFoundPort}/mcp/cancelled`),
          token: GLOBAL_TOKEN,
          server: { command: process.execPath },
          stopped: aborted.signal,
          onDiagnostic: (level, values) =>
            cancelledLogs.append({ server: 'cancelled', level, source: 'controller' }, values),
        }),
      'Cancelled',
      'The test stopped because the gateway or this server changed.',
    );
    expect(cancelledLogs.read({ after: 0 }).entries).toHaveLength(0);
  });
});

describe('McpGatewayController lifecycle and invariants', () => {
  test('open initializes mcp.json with plaintext token, with KeyStore tokenRef, or records KeySetupFailed on set() error or read-back mismatch', async () => {
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

    // Read-back verification mismatch in createKeyRef records KeySetupFailed
    const mismatchPath = await createTempConfigPath();
    const mismatchPort = await reservePort();
    const mismatchStore = createMemoryKeyStore({ mismatchGet: true }).store;
    const mismatchController = await McpGatewayController.open(
      mismatchPath,
      undefined,
      mismatchStore,
      mismatchPort,
    );
    activeControllers.push(mismatchController);

    const mismatchSnap = mismatchController.snapshot();
    expect(mismatchSnap.configError?.code).toBe('KeySetupFailed');
    expect(mismatchSnap.running).toBe(false);
    expect(
      mismatchController
        .readLogs({ after: 0 })
        .entries.some((entry) => entry.text.includes('A key could not be stored in Keychain.')),
    ).toBe(true);
  });

  test('supports autoStart, start, testServer, readLogs/clearLogs, and stop', async () => {
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

  test('migrateKeys moves literal gateway and server tokens into KeyStore while keeping listener running, and enforces error branches (Plan 029)', async () => {
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

    // Unsigned controller without KeyStore rejects migrateKeys
    const unsignedPort = await reservePort();
    const unsignedPath = await createTempConfigPath();
    const unsignedController = await McpGatewayController.open(
      unsignedPath,
      undefined,
      undefined,
      unsignedPort,
    );
    activeControllers.push(unsignedController);
    await expectAsyncGatewayError(
      () =>
        unsignedController.migrateKeys(
          { gateway: true, servers: [] },
          unsignedController.snapshot().revision,
        ),
      'InvalidConfig',
      'Keys can move to Keychain only in the signed app.',
    );

    const { store, entries } = createMemoryKeyStore();
    const controller = await McpGatewayController.open(configPath, undefined, store, port);
    activeControllers.push(controller);

    const started = await controller.start();
    expect(started.running).toBe(true);
    expect(started.keyMigration).toEqual({ gateway: true, servers: ['alpha'] });

    // Stale expectedRevision rejected with StaleRevision
    await expectAsyncGatewayError(
      () => controller.migrateKeys({ gateway: true, servers: [] }, 'stale-revision'),
      'StaleRevision',
    );

    // Empty slots rejected with InvalidConfig
    await expectAsyncGatewayError(
      () => controller.migrateKeys({ gateway: false, servers: [] }, started.revision),
      'InvalidConfig',
    );

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

  test('live ConfigDirectoryWatch hot-reloads valid external config edits and stops listener on invalid external config', async () => {
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
        mcpServers: {},
      }),
      { mode: 0o600 },
    );

    const controller = await McpGatewayController.open(configPath, undefined, undefined, port);
    activeControllers.push(controller);
    expect(controller.snapshot().running).toBe(true);
    expect(controller.snapshot().servers).toEqual([]);

    // Externally overwrite mcp.json with a valid config adding server "added"
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
          added: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
          },
        },
      }),
      { mode: 0o600 },
    );

    await waitFor(
      () => controller.snapshot().servers.some((s) => s.name === 'added' && s.status === 'mounted'),
      'ConfigDirectoryWatch hot-reload of externally added server',
    );

    // Externally overwrite mcp.json with malformed JSON ('{') while running
    await fs.writeFile(configPath, '{', { mode: 0o600 });

    await waitFor(
      () => !controller.snapshot().running && controller.snapshot().configError !== null,
      'ConfigDirectoryWatch stopping listener on invalid external config',
    );

    const invalidSnap = controller.snapshot();
    expect(invalidSnap.running).toBe(false);
    expect(invalidSnap.configError?.code).toBe('InvalidConfig');
    expect(
      controller
        .readLogs({ after: 0 })
        .entries.some((entry) =>
          entry.text.includes('Invalid external configuration; listener stopped.'),
        ),
    ).toBe(true);
  });

  test('records KeyUnavailable when config contains tokenRef without KeyStore and rejects methods with Closed after close()', async () => {
    const port = await reservePort();
    const configPath = await createTempConfigPath();
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          tokenRef: '00000000-0000-4000-8000-000000000001',
        },
        mcpServers: {},
      }),
      { mode: 0o600 },
    );

    const controller = await McpGatewayController.open(configPath, undefined, undefined, port);
    activeControllers.push(controller);

    const snap = controller.snapshot();
    expect(snap.configError?.code).toBe('KeyUnavailable');
    await expectAsyncGatewayError(
      () => controller.start(),
      'KeyUnavailable',
      'Keys stored in Keychain need the signed MCP Gateway app.',
    );

    await controller.close();
    expectGatewayError(
      () => (controller as unknown as { ensureOpen: () => void }).ensureOpen(),
      'Closed',
      'The controller is closed.',
    );

    await expectAsyncGatewayError(() => controller.start(), 'Closed', 'The controller is closed.');
    await expectAsyncGatewayError(() => controller.stop(), 'Closed', 'The controller is closed.');
    await expectAsyncGatewayError(
      () => controller.saveConfig('{}', snap.revision),
      'Closed',
      'The controller is closed.',
    );
    await expectAsyncGatewayError(
      () => controller.testServer('alpha', snap.revision),
      'Closed',
      'The controller is closed.',
    );
    await expectAsyncGatewayError(
      () => controller.migrateKeys({ gateway: true, servers: [] }, snap.revision),
      'Closed',
      'The controller is closed.',
    );
  });
});
