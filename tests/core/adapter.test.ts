import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  backendSummary,
  closeMount,
  type GatewayMount,
  MODERN_VERSION,
} from '@mcp-gateway/core/adapter';
import { GatewayError } from '@mcp-gateway/core/errors';
import { BACKEND_CAPACITY_ERROR, BackendCalls, ResourceAdmission } from '@mcp-gateway/core/limits';
import { isRecord } from '@mcp-gateway/shared/config-document';
import type { StdioServerConfig } from '@mcp-gateway/shared/types';
import {
  closeServer,
  createMountHarness,
  encodeBase64Header,
  listen,
  modernMeta,
  parseSseMessages,
  readBodyText,
  registerAsyncCleanups,
} from '../helpers/http-mount';

const GENERIC_BACKEND_SUMMARY = 'A backend operation failed. Open Logs for details.';
const DISCOVERY_BYTES = 64 * 1024;

const trackCleanup = registerAsyncCleanups();

const STDIO_SERVER_SCRIPT = `
let buffer = '';
process.stdin.setEncoding('utf8');
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'server/discover') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          supportedVersions: ['2026-07-28'],
          protocolVersion: '2026-07-28',
          serverInfo: { name: 'stdio-fixture', version: '1.2.3' },
          capabilities: { tools: { listChanged: false }, resources: {} },
        },
      });
    } else if (msg.method === 'ping') {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'tools/list') {
      const cursor = msg.params?.cursor;
      if (process.env.TOOLS_CURSOR_MODE === 'loop') {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [], nextCursor: 'loop' },
        });
      } else if (process.env.TOOLS_CURSOR_MODE === 'paged' && !cursor) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [{ name: 'page1_tool', inputSchema: { type: 'object', properties: {} } }],
            nextCursor: 'page-2',
          },
        });
      } else if (process.env.TOOLS_CURSOR_MODE === 'paged' && cursor === 'page-2') {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'page2_nested',
                inputSchema: {
                  type: 'object',
                  properties: {
                    filter: {
                      type: 'object',
                      properties: {
                        region: { type: 'string', 'x-mcp-header': 'Region' },
                      },
                    },
                  },
                },
              },
            ],
          },
        });
      } else {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'echo',
                inputSchema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    tenant: { type: 'string', 'x-mcp-header': 'Tenant' },
                    count: { type: 'integer', 'x-mcp-header': 'Count' },
                  },
                },
              },
              {
                name: 'stream_tool',
                inputSchema: { type: 'object', properties: {} },
              },
              {
                name: 'café/tool',
                inputSchema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', 'x-mcp-header': 'Label' },
                  },
                },
              },
            ],
          },
        });
      }
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (name === 'stream_tool') {
        write({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: 'p1', progress: 1, total: 2 },
        });
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'streamed-ok' }] },
        });
      } else if (name === 'wizard') {
        const state = msg.params?.requestState;
        if (!state) {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              resultType: 'input_required',
              requestState: 'step-1',
              pid: process.pid,
            },
          });
          if (msg.params?.arguments?.exitAfterRetain) {
            setTimeout(() => process.exit(0), 30);
          }
        } else {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              resultType: 'completed',
              restoredState: state,
              pid: process.pid,
            },
          });
        }
      } else if (name === 'server_request_tool') {
        write({
          jsonrpc: '2.0',
          id: 99,
          method: 'sampling/createMessage',
          params: {},
        });
      } else {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ name, arguments: msg.params?.arguments ?? {} }),
              },
            ],
          },
        });
      }
    } else if (msg.method === 'resources/read') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { contents: [{ uri: msg.params?.uri, text: 'resource-body' }] },
      });
    } else if (msg.method === 'notifications/custom_fail') {
      process.exit(1);
    } else if (msg.method === 'notifications/custom_ok') {
      // Wait for stdin EOF from LeasedStdio.finish() and exit 0 cleanly.
    } else if (msg.id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;

const stdioFixtureConfig = (overrides: Partial<StdioServerConfig> = {}) => ({
  command: process.execPath,
  args: ['-e', STDIO_SERVER_SCRIPT],
  ...overrides,
});

describe('backendSummary', () => {
  test('classifies allowlisted POSIX/network error codes including nested cause', () => {
    for (const code of [
      'EADDRINUSE',
      'EACCES',
      'ENOENT',
      'EPERM',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
    ]) {
      expect(backendSummary([{ code }])).toBe(
        `Backend failed (${code}). Check the executable, permissions or connection. Open Logs for details.`,
      );
    }
    const wrapped = new Error('spawn failed', { cause: { code: 'ENOENT' } });
    expect(backendSummary(['MCP child failed:', wrapped])).toBe(
      'Backend failed (ENOENT). Check the executable, permissions or connection. Open Logs for details.',
    );
  });

  test('falls back to generic summary for non-allowlisted code EADDRNOTAVAIL', () => {
    expect(backendSummary([{ code: 'EADDRNOTAVAIL' }])).toBe(GENERIC_BACKEND_SUMMARY);
  });

  test('classifies child exit codes and signal exits, rejecting invalid values', () => {
    expect(backendSummary(['Child exited: code=1, signal=null'])).toBe(
      'Backend process exited (code 1, signal null). Open Logs for details.',
    );
    expect(backendSummary([new Error('Child exited: code=127, signal=null')])).toBe(
      'Backend process exited (code 127, signal null). Open Logs for details.',
    );
    expect(backendSummary(['Child exited: code=null, signal=SIGTERM'])).toBe(
      'Backend process exited (code null, signal SIGTERM). Open Logs for details.',
    );
    expect(backendSummary([new Error('Child exited: code=null, signal=SIGKILL')])).toBe(
      'Backend process exited (code null, signal SIGKILL). Open Logs for details.',
    );
    expect(backendSummary(['Child exited: code=300, signal=null'])).toBe(GENERIC_BACKEND_SUMMARY);
    expect(backendSummary(['Child exited: code=null, signal=SIGFAKE'])).toBe(
      GENERIC_BACKEND_SUMMARY,
    );
  });

  test('classifies HTTP status fields and remote error messages', () => {
    expect(backendSummary([{ status: 503 }])).toBe(
      'Backend HTTP request failed (503). Open Logs for details.',
    );
    expect(backendSummary([{ code: 502 }])).toBe(
      'Backend HTTP request failed (502). Open Logs for details.',
    );
    expect(backendSummary([new Error('The remote server answered 504')])).toBe(
      'Backend HTTP request failed (504). Open Logs for details.',
    );
    expect(
      backendSummary([new Error('Streamable HTTP error: Error POSTing to endpoint: 401 details')]),
    ).toBe('Backend HTTP request failed (401). Open Logs for details.');
  });

  test('returns generic fallback for unknown errors, circular objects, and getter traps', () => {
    expect(backendSummary([])).toBe(GENERIC_BACKEND_SUMMARY);
    expect(backendSummary(['unexpected failure', new Error('sensitive secret=abc')])).toBe(
      GENERIC_BACKEND_SUMMARY,
    );

    const circular: Record<string, unknown> = {};
    circular.cause = circular;
    expect(backendSummary([circular])).toBe(GENERIC_BACKEND_SUMMARY);

    let getterInvoked = false;
    const trap = Object.defineProperty({}, 'code', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'ENOENT';
      },
    });
    expect(backendSummary([trap])).toBe(GENERIC_BACKEND_SUMMARY);
    expect(getterInvoked).toBe(false);
  });
});

describe('closeMount', () => {
  test('caches mount.close() promise so concurrent and repeat calls share one cleanup', async () => {
    let closeCalls = 0;
    let releaseClose!: () => void;
    const mount: GatewayMount = {
      handle: async () => {},
      close: () => {
        closeCalls++;
        return new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      },
    };

    const first = closeMount(mount);
    const second = closeMount(mount);
    await Promise.resolve();
    expect(closeCalls).toBe(1);

    releaseClose();
    await Promise.all([first, second]);

    await closeMount(mount);
    expect(closeCalls).toBe(1);
  });

  test('wraps mount.close() rejection as ShutdownFailure GatewayError and invokes onFailure', async () => {
    let closeCalls = 0;
    const rootCause = new Error('cleanup refused');
    const mount: GatewayMount = {
      handle: async () => {},
      close: async () => {
        closeCalls++;
        throw rootCause;
      },
    };

    const observed: unknown[] = [];
    let caught: unknown;
    try {
      await closeMount(mount, (error) => observed.push(error));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).code).toBe('ShutdownFailure');
    expect((caught as GatewayError).message).toBe('Backend cleanup did not complete successfully.');
    expect(observed).toEqual([rootCause]);
    expect(closeCalls).toBe(1);

    // Subsequent retries reuse the cached rejection without re-invoking mount.close().
    let retryCaught: unknown;
    try {
      await closeMount(mount, (error) => observed.push(error));
    } catch (error) {
      retryCaught = error;
    }
    expect(retryCaught).toBeInstanceOf(GatewayError);
    expect((retryCaught as GatewayError).code).toBe('ShutdownFailure');
    expect(observed).toEqual([rootCause, rootCause]);
    expect(closeCalls).toBe(1);
  });
});

describe('createMount stateless 2026-07-28 stdio bridging and header validation', () => {
  test('bridges server/discover returning supportedVersions, protocolVersion, serverInfo, and capabilities', async () => {
    const harness = await createMountHarness({ server: stdioFixtureConfig(), trackCleanup });

    const response = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'discover-1',
        method: 'server/discover',
        params: { _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'server/discover',
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 'discover-1',
      result: {
        supportedVersions: [MODERN_VERSION],
        protocolVersion: MODERN_VERSION,
        serverInfo: { name: 'stdio-fixture', version: '1.2.3' },
        capabilities: { tools: { listChanged: false }, resources: {} },
      },
    });
    await harness.waitForIdle();
    expect(harness.diagnostics).toEqual([]);
  });

  test('bridges ping, tools/call (JSON and SSE), and base64-encoded non-ASCII headers', async () => {
    const harness = await createMountHarness({ server: stdioFixtureConfig(), trackCleanup });

    // 1. ping
    const pingRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'ping',
      },
    );
    expect(pingRes.status).toBe(200);
    expect(await pingRes.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    // 2. tools/call with mirrored x-mcp-header params (string + integer matching 42.0 === 42)
    const callRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { text: 'hello', tenant: 'acme', count: 42 },
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'echo',
        'mcp-param-tenant': 'acme',
        'mcp-param-count': '42.0',
      },
    );
    expect(callRes.status).toBe(200);
    expect(callRes.headers.get('content-type')).toContain('application/json');
    expect(await callRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: 'echo',
              arguments: { text: 'hello', tenant: 'acme', count: 42 },
            }),
          },
        ],
      },
    });

    // 3. tools/call with =?base64?...?= encoded non-ASCII tool name and parameter
    const nonAsciiCall = await harness.post(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'café/tool',
          arguments: { label: 'résumé' },
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': encodeBase64Header('café/tool'),
        'mcp-param-label': encodeBase64Header('résumé'),
      },
    );
    expect(nonAsciiCall.status).toBe(200);
    expect(await nonAsciiCall.json()).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ name: 'café/tool', arguments: { label: 'résumé' } }),
          },
        ],
      },
    });

    // 4. resources/read with =?base64?...?= encoded non-ASCII URI
    const resourceUri = 'file:///données/note.md';
    const resourceRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: resourceUri, _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'resources/read',
        'mcp-name': encodeBase64Header(resourceUri),
      },
    );
    expect(resourceRes.status).toBe(200);
    expect(await resourceRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { contents: [{ uri: resourceUri, text: 'resource-body' }] },
    });

    // 5. tools/call returning a progress notification + terminal result upgrades to SSE
    const sseRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'stream_tool', arguments: {}, _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'stream_tool',
      },
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    const frames = parseSseMessages(await sseRes.text());
    expect(frames).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'p1', progress: 1, total: 2 },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        result: { content: [{ type: 'text', text: 'streamed-ok' }] },
      },
    ]);

    await harness.waitForIdle();
    expect(harness.diagnostics).toEqual([]);
  });

  test('rejects mismatched mcp-method, mcp-name, mcp-protocol-version, and mcp-param-* headers with HTTP 400 and -32020', async () => {
    const harness = await createMountHarness({ server: stdioFixtureConfig(), trackCleanup });

    // Mismatched mcp-method
    const badMethod = await harness.post(
      { jsonrpc: '2.0', id: 10, method: 'ping', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list' },
    );
    expect(badMethod.status).toBe(400);
    expect(await badMethod.json()).toEqual({
      jsonrpc: '2.0',
      id: 10,
      error: {
        code: -32020,
        message: 'Request header mcp-method does not match the request body',
      },
    });

    // Mismatched mcp-name
    const badName = await harness.post(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'echo', arguments: {}, _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'other-tool',
      },
    );
    expect(badName.status).toBe(400);
    expect(await badName.json()).toEqual({
      jsonrpc: '2.0',
      id: 11,
      error: {
        code: -32020,
        message: 'Request header mcp-name does not match the request body',
      },
    });

    // Malformed =?base64?...?= in mcp-name
    const badBase64 = await harness.post(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'echo', arguments: {}, _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': '=?base64?not-valid-base64!?=',
      },
    );
    expect(badBase64.status).toBe(400);
    expect(await badBase64.json()).toEqual({
      jsonrpc: '2.0',
      id: 12,
      error: {
        code: -32020,
        message: 'Request header mcp-name does not match the request body',
      },
    });

    // Mismatched mcp-protocol-version
    const badVersion = await harness.post(
      { jsonrpc: '2.0', id: 13, method: 'ping', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'ping' },
    );
    expect(badVersion.status).toBe(400);
    expect(await badVersion.json()).toEqual({
      jsonrpc: '2.0',
      id: 13,
      error: {
        code: -32020,
        message: 'Request header mcp-protocol-version does not match the request body',
      },
    });

    // Mismatched mcp-param-* vs tool inputSchema x-mcp-header
    const badParam = await harness.post(
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { tenant: 'acme', count: 5 },
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'echo',
        'mcp-param-tenant': 'wrong-tenant',
        'mcp-param-count': '5',
      },
    );
    expect(badParam.status).toBe(400);
    expect(await badParam.json()).toEqual({
      jsonrpc: '2.0',
      id: 14,
      error: {
        code: -32020,
        message: 'Request header mcp-param-tenant does not match the request body',
      },
    });

    await harness.waitForIdle();
    // HeaderMismatch is client-caused and must not mark the backend as failed.
    expect(harness.diagnostics).toEqual([]);
  });

  test('rejects pre-2026-07-28 requests with HTTP 400 and UNSUPPORTED_PROTOCOL_ERROR when legacyProtocol is not enabled', async () => {
    const harness = await createMountHarness({
      server: stdioFixtureConfig({ legacyProtocol: false }),
      trackCleanup,
    });

    const expectedError = {
      code: -32600,
      message: 'Only MCP protocol version 2026-07-28 is supported.',
    };

    // Legacy initialize without mcp-protocol-version header or _meta envelope
    const legacyInit = await harness.post({
      jsonrpc: '2.0',
      id: 20,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-client', version: '1.0' },
      },
    });
    expect(legacyInit.status).toBe(400);
    expect(await legacyInit.json()).toEqual({
      jsonrpc: '2.0',
      id: 20,
      error: expectedError,
    });

    // initialize even with modern 2026-07-28 envelope is also refused
    const modernInit = await harness.post(
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'initialize',
        params: { _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'initialize',
      },
    );
    expect(modernInit.status).toBe(400);
    expect(await modernInit.json()).toEqual({
      jsonrpc: '2.0',
      id: 21,
      error: expectedError,
    });

    // Envelope claiming older revision 2025-11-25
    const olderRevision = await harness.post(
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'ping',
        params: { _meta: modernMeta('2025-11-25') },
      },
      {
        'mcp-protocol-version': '2025-11-25',
        'mcp-method': 'ping',
      },
    );
    expect(olderRevision.status).toBe(400);
    expect(await olderRevision.json()).toEqual({
      jsonrpc: '2.0',
      id: 22,
      error: expectedError,
    });

    await harness.waitForIdle();
    expect(harness.diagnostics).toEqual([]);
  });
});

describe('createMount upstream HTTP 2026-07-28 bridging', () => {
  test('forwards configured server.headers, never forwards inbound Authorization, and returns JSON and SSE responses', async () => {
    const received: Array<{ method: string; headers: IncomingMessage['headers'] }> = [];
    const upstream = createServer((req, res) => {
      void (async () => {
        const text = await readBodyText(req);
        const body: unknown = JSON.parse(text);
        if (!isRecord(body) || typeof body.method !== 'string') {
          res.writeHead(400).end();
          return;
        }
        received.push({ method: body.method, headers: req.headers });
        if (body.method === 'server/discover') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { supportedVersions: [MODERN_VERSION] },
            }),
          );
          return;
        }
        if (body.method === 'tools/list') {
          const params = isRecord(body.params) ? body.params : undefined;
          if (params?.cursor === 'sse') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: 'up-1', progress: 1, total: 1 },
              })}\n\n`,
            );
            res.end(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { tools: [{ name: 'streamed_remote_tool' }] },
              })}\n\n`,
            );
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: [{ name: 'remote_echo' }] },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })().catch(() => res.destroy());
    });
    const upstreamPort = await listen(upstream);
    trackCleanup(() => closeServer(upstream));

    const harness = await createMountHarness({
      server: {
        url: `http://127.0.0.1:${upstreamPort}/mcp`,
        headers: {
          'x-upstream-api-key': 'configured-upstream-secret',
          'x-tenant': 'blue',
        },
      },
      trackCleanup,
    });

    // JSON response from upstream
    const jsonRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'up-json-1',
        method: 'tools/list',
        params: { _meta: modernMeta() },
      },
      {
        authorization: 'Bearer gateway-inbound-token-must-not-leak',
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/list',
      },
    );
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toContain('application/json');
    expect(await jsonRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'up-json-1',
      result: { tools: [{ name: 'remote_echo' }] },
    });

    // SSE response from upstream
    const sseRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'up-sse-2',
        method: 'tools/list',
        params: { cursor: 'sse', _meta: modernMeta() },
      },
      {
        authorization: 'Bearer another-gateway-token-must-not-leak',
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/list',
      },
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    expect(parseSseMessages(await sseRes.text())).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'up-1', progress: 1, total: 1 },
      },
      {
        jsonrpc: '2.0',
        id: 'up-sse-2',
        result: { tools: [{ name: 'streamed_remote_tool' }] },
      },
    ]);

    await harness.waitForIdle();
    expect(harness.diagnostics).toEqual([]);

    // 1 cached server/discover + 2 tools/list calls
    expect(received.map((entry) => entry.method)).toEqual([
      'server/discover',
      'tools/list',
      'tools/list',
    ]);
    for (const entry of received) {
      expect(entry.headers['x-upstream-api-key']).toBe('configured-upstream-secret');
      expect(entry.headers['x-tenant']).toBe('blue');
      expect(entry.headers.authorization).toBeUndefined();
      expect(entry.headers['mcp-protocol-version']).toBe(MODERN_VERSION);
      expect(entry.headers['mcp-method']).toBe(entry.method);
    }
  });

  test('refuses upstream HTTP 302 redirects on both discovery and forwarded calls (redirect: error)', async () => {
    let redirectTargetHits = 0;
    let redirectOnDiscover = false;

    const upstream = createServer((req, res) => {
      void (async () => {
        if (req.url === '/redirected') {
          redirectTargetHits++;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
          return;
        }
        const text = await readBodyText(req);
        const body: unknown = JSON.parse(text);
        if (!isRecord(body) || typeof body.method !== 'string') {
          res.writeHead(400).end();
          return;
        }
        if (body.method === 'server/discover' && !redirectOnDiscover) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { supportedVersions: [MODERN_VERSION] },
            }),
          );
          return;
        }
        res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/redirected` });
        res.end();
      })().catch(() => res.destroy());
    });
    const upstreamPort = await listen(upstream);
    trackCleanup(() => closeServer(upstream));

    // 1. 302 on forwarded tools/list after modern discovery succeeds
    const callHarness = await createMountHarness({
      server: { url: `http://127.0.0.1:${upstreamPort}/mcp` },
      trackCleanup,
    });
    const callRes = await callHarness.post(
      {
        jsonrpc: '2.0',
        id: 'redir-call',
        method: 'tools/list',
        params: { _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/list',
      },
    );
    expect(await callRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'redir-call',
      error: { code: -32603, message: 'MCP server process failed' },
    });
    await callHarness.waitForIdle();
    expect(redirectTargetHits).toBe(0);

    // 2. 302 during server/discover
    redirectOnDiscover = true;
    const discoverHarness = await createMountHarness({
      server: { url: `http://127.0.0.1:${upstreamPort}/mcp` },
      trackCleanup,
    });
    const discoverRes = await discoverHarness.post(
      {
        jsonrpc: '2.0',
        id: 'redir-discover',
        method: 'tools/list',
        params: { _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/list',
      },
    );
    expect(discoverRes.status).toBe(400);
    expect(await discoverRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'redir-discover',
      error: {
        code: -32600,
        message: 'Only MCP protocol version 2026-07-28 is supported.',
      },
    });
    await discoverHarness.waitForIdle();
    expect(redirectTargetHits).toBe(0);
  });
});

type DiscoveryFormat = 'json' | 'sse';
type DiscoveryReply =
  | 'supported'
  | 'unsupported'
  | 'malformed'
  | 'invalid-utf8'
  | 'at-limit'
  | 'oversized'
  | 'reset-before-headers'
  | 'reset-mid-body'
  | 'unavailable';

const writeDiscoveryReply = (
  res: ServerResponse,
  id: string | number,
  reply: DiscoveryReply,
  format: DiscoveryFormat,
) => {
  if (reply === 'reset-before-headers') {
    res.destroy();
    return;
  }
  const encode = (json: string) => Buffer.from(format === 'sse' ? `data: ${json}\n\n` : json);
  const result = {
    jsonrpc: '2.0',
    id,
    result: {
      supportedVersions: reply === 'unsupported' ? ['2025-11-25'] : [MODERN_VERSION],
      note: '',
    },
  };
  let body = encode(JSON.stringify(result));
  if (reply === 'malformed') body = encode('{');
  if (reply === 'invalid-utf8') {
    result.result.note = 'x';
    body = encode(JSON.stringify(result));
    body[body.indexOf('"note":"x"') + '"note":"'.length] = 0xff;
  }
  if (reply === 'at-limit' || reply === 'oversized') {
    result.result.note = ' '.repeat(
      DISCOVERY_BYTES - body.length + (reply === 'oversized' ? 1 : 0),
    );
    body = encode(JSON.stringify(result));
  }
  res.writeHead(reply === 'unavailable' ? 503 : 200, {
    'content-type': format === 'sse' ? 'text/event-stream' : 'application/json',
    'content-length': body.length,
  });
  if (reply === 'reset-mid-body') {
    res.write(body.subarray(0, body.length - 2));
    const timer = setTimeout(() => res.destroy(), 50);
    res.once('close', () => clearTimeout(timer));
  } else {
    res.end(body);
  }
};

describe('UpstreamDiscovery caching, retry, and 64 KiB boundary', () => {
  const withDiscoveryFixture = async (
    reply: DiscoveryReply,
    format: DiscoveryFormat,
    check: (fixture: {
      request: () => Promise<{ status: number; body: unknown }>;
      recover: () => void;
      discoveries: () => number;
      forwarded: () => number;
    }) => Promise<void>,
  ) => {
    let discoveries = 0;
    let forwarded = 0;
    let recovered = false;

    const upstream = createServer((req, res) => {
      void (async () => {
        const text = await readBodyText(req);
        const message: unknown = JSON.parse(text);
        if (
          !isRecord(message) ||
          (typeof message.id !== 'string' && typeof message.id !== 'number')
        )
          throw new Error('Expected JSON-RPC request with id');
        if (message.method === 'server/discover') {
          discoveries++;
          writeDiscoveryReply(res, message.id, recovered ? 'supported' : reply, format);
        } else {
          forwarded++;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        }
      })().catch(() => res.destroy());
    });
    const upstreamPort = await listen(upstream);
    trackCleanup(() => closeServer(upstream));

    const harness = await createMountHarness({
      server: { url: `http://127.0.0.1:${upstreamPort}/mcp` },
      trackCleanup,
    });

    await check({
      request: async () => {
        const response = await harness.post(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'ping',
            params: { _meta: modernMeta() },
          },
          {
            'mcp-protocol-version': MODERN_VERSION,
            'mcp-method': 'ping',
          },
        );
        return { status: response.status, body: await response.json() };
      },
      recover: () => {
        recovered = true;
      },
      discoveries: () => discoveries,
      forwarded: () => forwarded,
    });
  };

  for (const [label, reply, format] of [
    ['reset-before-headers', 'reset-before-headers', 'json'],
    ['json reset-mid-body', 'reset-mid-body', 'json'],
    ['sse reset-mid-body', 'reset-mid-body', 'sse'],
    ['HTTP 503 unavailable', 'unavailable', 'json'],
  ] as const) {
    test(`transient failure (${label}) is not negative-cached and retries immediately`, async () => {
      await withDiscoveryFixture(reply, format, async (fixture) => {
        const first = await fixture.request();
        expect(first.status).toBe(400);
        expect(first.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32600 } });
        expect(fixture.discoveries()).toBe(1);
        expect(fixture.forwarded()).toBe(0);

        fixture.recover();
        expect(await fixture.request()).toEqual({
          status: 200,
          body: { jsonrpc: '2.0', id: 1, result: {} },
        });
        expect(fixture.discoveries()).toBe(2);
        expect(fixture.forwarded()).toBe(1);

        expect(await fixture.request()).toEqual({
          status: 200,
          body: { jsonrpc: '2.0', id: 1, result: {} },
        });
        expect(fixture.discoveries()).toBe(2);
        expect(fixture.forwarded()).toBe(2);
      });
    });
  }

  for (const [label, reply, format] of [
    ['json unsupported version', 'unsupported', 'json'],
    ['sse unsupported version', 'unsupported', 'sse'],
    ['json malformed payload', 'malformed', 'json'],
    ['sse malformed payload', 'malformed', 'sse'],
    ['json invalid-utf8 0xff', 'invalid-utf8', 'json'],
    ['sse invalid-utf8 0xff', 'invalid-utf8', 'sse'],
    ['json oversized 64 KiB + 1', 'oversized', 'json'],
    ['sse oversized 64 KiB + 1', 'oversized', 'sse'],
  ] as const) {
    test(`protocol/framing failure (${label}) stays refused and negative-cached`, async () => {
      await withDiscoveryFixture(reply, format, async (fixture) => {
        const first = await fixture.request();
        expect(first.status).toBe(400);
        expect(first.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32600 } });

        fixture.recover();
        const second = await fixture.request();
        expect(second.status).toBe(400);
        expect(second.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32600 } });
        expect(fixture.discoveries()).toBe(1);
        expect(fixture.forwarded()).toBe(0);
      });
    });
  }

  for (const format of ['json', 'sse'] as const) {
    test(`${format}: valid server/discover reply at exact 64 KiB limit succeeds`, async () => {
      await withDiscoveryFixture('at-limit', format, async (fixture) => {
        expect(await fixture.request()).toEqual({
          status: 200,
          body: { jsonrpc: '2.0', id: 1, result: {} },
        });
        expect(fixture.discoveries()).toBe(1);
        expect(fixture.forwarded()).toBe(1);
      });
    });
  }
});

describe('createMount resource and call capacity enforcement', () => {
  test('BackendCalls(1) refuses concurrent second call with 429 and JSON-RPC 1001, then releases slot on completion', async () => {
    let holdNext = true;
    let notifyArrived!: () => void;
    const firstArrived = new Promise<void>((resolve) => {
      notifyArrived = resolve;
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const upstream = createServer((req, res) => {
      void (async () => {
        const text = await readBodyText(req);
        const body: unknown = JSON.parse(text);
        if (!isRecord(body) || typeof body.method !== 'string') {
          res.writeHead(400).end();
          return;
        }
        if (body.method === 'server/discover') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { supportedVersions: [MODERN_VERSION] },
            }),
          );
          return;
        }
        if (body.method === 'tools/list') {
          if (holdNext) {
            holdNext = false;
            notifyArrived();
            await gate;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: [{ name: 'ok' }] },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })().catch(() => res.destroy());
    });
    const upstreamPort = await listen(upstream);
    trackCleanup(() => closeServer(upstream));

    const harness = await createMountHarness({
      server: { url: `http://127.0.0.1:${upstreamPort}/mcp` },
      calls: new BackendCalls(1),
      trackCleanup,
    });

    // Hold call 1 in flight
    const firstPromise = harness.post(
      { jsonrpc: '2.0', id: 'call-1', method: 'tools/list', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list' },
    );
    await firstArrived;

    // Concurrent call 2 must be refused with HTTP 429 and JSON-RPC code 1001
    const secondRes = await harness.post(
      { jsonrpc: '2.0', id: 'call-2', method: 'tools/list', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list' },
    );
    expect(secondRes.status).toBe(429);
    expect(await secondRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'call-2',
      error: {
        code: BACKEND_CAPACITY_ERROR.code,
        message: BACKEND_CAPACITY_ERROR.message,
      },
    });
    expect(BACKEND_CAPACITY_ERROR.code).toBe(1001);

    // Release call 1 and confirm it succeeds
    releaseFirst();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'call-1',
      result: { tools: [{ name: 'ok' }] },
    });
    await harness.waitForIdle();

    // After call 1 completes, the slot is released and a subsequent call succeeds
    const thirdRes = await harness.post(
      { jsonrpc: '2.0', id: 'call-3', method: 'tools/list', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list' },
    );
    expect(thirdRes.status).toBe(200);
    expect(await thirdRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'call-3',
      result: { tools: [{ name: 'ok' }] },
    });
    await harness.waitForIdle();
    expect(harness.diagnostics).toEqual([]);
  });

  test('ResourceAdmission(0) refuses new stdio request cleanly with 429 without spawning child processes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bear-mcp-adapter-'));
    trackCleanup(async () => {
      rmSync(tempDir, { recursive: true, force: true });
    });
    const markerPath = join(tempDir, 'spawned.marker');
    const calls = new BackendCalls(1);

    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned');`],
      },
      admission: new ResourceAdmission(0),
      calls,
      trackCleanup,
    });

    const response = await harness.post(
      { jsonrpc: '2.0', id: 'no-slot', method: 'ping', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'ping' },
    );

    expect(response.status).toBe(429);
    await harness.waitForIdle();
    expect(existsSync(markerPath)).toBe(false);
    expect(harness.diagnostics).toEqual([]);

    // BackendCalls slot must also be released when admission refused before child creation.
    const owner = calls.owner();
    expect(calls.admit(owner, 'after-refusal')).toBe(true);
    calls.settleOwner(owner);
  });

  test('ResourceAdmission(1) releases lease after stdio child cleanup so subsequent requests succeed', async () => {
    const admission = new ResourceAdmission(1);
    const harness = await createMountHarness({
      server: stdioFixtureConfig(),
      admission,
      trackCleanup,
    });

    const first = await harness.post(
      { jsonrpc: '2.0', id: 101, method: 'ping', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'ping' },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ jsonrpc: '2.0', id: 101, result: {} });
    await harness.waitForIdle();

    const second = await harness.post(
      { jsonrpc: '2.0', id: 102, method: 'ping', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'ping' },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ jsonrpc: '2.0', id: 102, result: {} });
    await harness.waitForIdle();

    // Confirm the single ResourceAdmission lease is completely released back to the pool.
    const lease = admission.acquire();
    expect(lease).toBeDefined();
    lease?.release();
    expect(harness.diagnostics).toEqual([]);
  });
});

describe('RetainedChildren continuation lifecycle, findToolSchema pagination, and modern protocol edge cases', () => {
  test('EDGE-08: input_required mints sgw:<uuid> continuation handle, reuses retained child, and rejects expired or exited handles with -32602', async () => {
    const harness = await createMountHarness({
      server: stdioFixtureConfig(),
      trackCleanup,
    });

    // 1. Initial call returns input_required -> gateway rewrites requestState to sgw:<uuid>
    const step1Res = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'cont-1',
        method: 'tools/call',
        params: {
          name: 'wizard',
          arguments: {},
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'wizard',
      },
    );
    expect(step1Res.status).toBe(200);
    const step1Body = (await step1Res.json()) as {
      jsonrpc: string;
      id: string;
      result: { resultType: string; requestState: string; pid: number };
    };
    expect(step1Body.result.resultType).toBe('input_required');
    expect(step1Body.result.requestState).toMatch(/^sgw:[0-9a-f-]{36}$/);
    const retainedHandle = step1Body.result.requestState;
    const initialPid = step1Body.result.pid;

    // 2. Follow-up request with params.requestState = "sgw:..." reuses the same child and restores 'step-1'
    const step2Res = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'cont-2',
        method: 'tools/call',
        params: {
          name: 'wizard',
          arguments: {},
          requestState: retainedHandle,
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'wizard',
      },
    );
    expect(step2Res.status).toBe(200);
    const step2Body = (await step2Res.json()) as {
      jsonrpc: string;
      id: string;
      result: { resultType: string; restoredState: string; pid: number };
    };
    expect(step2Body.result).toEqual({
      resultType: 'completed',
      restoredState: 'step-1',
      pid: initialPid,
    });

    // 3. Unknown sgw: handle returns HTTP 400 (-32602)
    const unknownRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'cont-unknown',
        method: 'tools/call',
        params: {
          name: 'wizard',
          arguments: {},
          requestState: 'sgw:00000000-0000-4000-8000-000000000000',
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'wizard',
      },
    );
    expect(unknownRes.status).toBe(400);
    expect(await unknownRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'cont-unknown',
      error: {
        code: -32602,
        message: 'Continuation expired or backend unavailable',
      },
    });

    // 4. Retained child exiting while idle discards its sgw: handle
    const exitRetainRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'cont-exit-1',
        method: 'tools/call',
        params: {
          name: 'wizard',
          arguments: { exitAfterRetain: true },
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'wizard',
      },
    );
    expect(exitRetainRes.status).toBe(200);
    const exitRetainBody = (await exitRetainRes.json()) as {
      result: { requestState: string };
    };
    const exitedHandle = exitRetainBody.result.requestState;
    expect(exitedHandle).toMatch(/^sgw:/);

    await Bun.sleep(100);

    const afterExitRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'cont-exit-2',
        method: 'tools/call',
        params: {
          name: 'wizard',
          arguments: {},
          requestState: exitedHandle,
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'wizard',
      },
    );
    expect(afterExitRes.status).toBe(400);
    expect(await afterExitRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'cont-exit-2',
      error: {
        code: -32602,
        message: 'Continuation expired or backend unavailable',
      },
    });
  });

  test('EDGE-09: findToolSchema paginates nextCursor with nested x-mcp-header validation and aborts on repeated cursor loop', async () => {
    const pagedHarness = await createMountHarness({
      server: stdioFixtureConfig({ env: { TOOLS_CURSOR_MODE: 'paged' } }),
      trackCleanup,
    });

    // Tool on page 2 with valid nested x-mcp-header
    const validNested = await pagedHarness.post(
      {
        jsonrpc: '2.0',
        id: 'page2-ok',
        method: 'tools/call',
        params: {
          name: 'page2_nested',
          arguments: { filter: { region: 'eu-west-1' } },
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'page2_nested',
        'mcp-param-region': 'eu-west-1',
      },
    );
    expect(validNested.status).toBe(200);
    expect(await validNested.json()).toEqual({
      jsonrpc: '2.0',
      id: 'page2-ok',
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: 'page2_nested',
              arguments: { filter: { region: 'eu-west-1' } },
            }),
          },
        ],
      },
    });

    // Mismatched nested x-mcp-header on page 2 -> 400 HeaderMismatch (-32020)
    const mismatchedNested = await pagedHarness.post(
      {
        jsonrpc: '2.0',
        id: 'page2-bad',
        method: 'tools/call',
        params: {
          name: 'page2_nested',
          arguments: { filter: { region: 'eu-west-1' } },
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'page2_nested',
        'mcp-param-region': 'us-east-1',
      },
    );
    expect(mismatchedNested.status).toBe(400);
    expect(await mismatchedNested.json()).toEqual({
      jsonrpc: '2.0',
      id: 'page2-bad',
      error: {
        code: -32020,
        message: 'Request header mcp-param-region does not match the request body',
      },
    });

    // Repeated nextCursor ('loop' -> 'loop') aborts with -32603 instead of infinite loop
    const loopHarness = await createMountHarness({
      server: stdioFixtureConfig({ env: { TOOLS_CURSOR_MODE: 'loop' } }),
      trackCleanup,
    });
    const loopRes = await loopHarness.post(
      {
        jsonrpc: '2.0',
        id: 'loop-1',
        method: 'tools/call',
        params: {
          name: 'missing_tool',
          arguments: {},
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'missing_tool',
      },
    );
    expect(loopRes.status).toBe(200);
    expect(await loopRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'loop-1',
      error: {
        code: -32603,
        message: 'MCP server process failed',
      },
    });
  });

  test('EDGE-10a: modern notifications return 202 on clean exit and 500 (-32603) on non-zero exit', async () => {
    const harness = await createMountHarness({
      server: stdioFixtureConfig(),
      trackCleanup,
    });

    const okNotif = await harness.post(
      {
        jsonrpc: '2.0',
        method: 'notifications/custom_ok',
        params: { _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'notifications/custom_ok',
      },
    );
    expect(okNotif.status).toBe(202);
    expect(await okNotif.text()).toBe('');

    const failNotif = await harness.post(
      {
        jsonrpc: '2.0',
        method: 'notifications/custom_fail',
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'notifications/custom_fail',
      },
    );
    expect(failNotif.status).toBe(500);
    expect(await failNotif.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        message: 'MCP server process failed',
      },
    });
  });

  test('EDGE-10b: HTTP admission status codes (415, 406, 405, 400 _meta, 404 -32601, and server request rejection)', async () => {
    const harness = await createMountHarness({
      server: stdioFixtureConfig({ legacyProtocol: false }),
      trackCleanup,
    });

    // POST with Content-Type: text/plain -> 415
    const badContentType = await harness.request('POST', {
      headers: {
        'content-type': 'text/plain',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'ping',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ct-1',
        method: 'ping',
        params: { _meta: modernMeta() },
      }),
    });
    expect(badContentType.status).toBe(415);

    // POST with Accept missing text/event-stream -> 406
    const badAccept = await harness.request('POST', {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'ping',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'acc-1',
        method: 'ping',
        params: { _meta: modernMeta() },
      }),
    });
    expect(badAccept.status).toBe(406);

    // GET, DELETE, and PUT when legacyProtocol is false -> 405
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await harness.request(method);
      expect(res.status).toBe(405);
    }

    // POST with mcp-protocol-version: 2026-07-28 header but missing _meta -> 400 (-32602)
    const missingMeta = await harness.post(
      { jsonrpc: '2.0', id: 'meta-missing', method: 'ping', params: {} },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'ping' },
    );
    expect(missingMeta.status).toBe(400);
    expect(await missingMeta.json()).toEqual({
      jsonrpc: '2.0',
      id: 'meta-missing',
      error: {
        code: -32602,
        message: 'Modern request requires _meta envelope',
      },
    });

    // POST with malformed _meta (clientInfo / clientCapabilities not objects) -> 400 (-32602)
    const malformedMeta = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'meta-bad',
        method: 'ping',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
            'io.modelcontextprotocol/clientInfo': 'not-an-object',
            'io.modelcontextprotocol/clientCapabilities': null,
          },
        },
      },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'ping' },
    );
    expect(malformedMeta.status).toBe(400);
    expect(await malformedMeta.json()).toEqual({
      jsonrpc: '2.0',
      id: 'meta-bad',
      error: {
        code: -32602,
        message: 'Invalid _meta envelope for protocol revision 2026-07-28',
      },
    });

    // Child returning JSON-RPC error -32601 -> mapped to HTTP 404
    const notFoundRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'unknown-method',
        method: 'custom/unknown',
        params: { _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'custom/unknown',
      },
    );
    expect(notFoundRes.status).toBe(404);
    expect(await notFoundRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'unknown-method',
      error: { code: -32601, message: 'Method not found' },
    });

    // Child sending a server-initiated JSON-RPC request on a modern stateless connection -> rejected with -32603
    const serverReqRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'srv-req-1',
        method: 'tools/call',
        params: {
          name: 'server_request_tool',
          arguments: {},
          _meta: modernMeta(),
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'server_request_tool',
      },
    );
    expect(await serverReqRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'srv-req-1',
      error: {
        code: -32603,
        message: 'MCP server process failed',
      },
    });
  });

  test('EDGE-10c: upstream SSE cross-chunk CRLF splitting parses cleanly and truncated SSE stream without terminal reply fails with -32603', async () => {
    const upstream = createServer((req, res) => {
      void (async () => {
        const text = await readBodyText(req);
        const body = JSON.parse(text) as {
          id?: string | number;
          method?: string;
          params?: { cursor?: string };
        };
        if (body.method === 'server/discover') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { supportedVersions: [MODERN_VERSION] },
            }),
          );
          return;
        }
        if (body.method === 'tools/list' && body.params?.cursor === 'split-crlf') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'crlf_tool' }] },
          });
          res.write(`event: message\r`);
          await Bun.sleep(15);
          res.write(`\ndata: ${payload}\r`);
          await Bun.sleep(15);
          res.end(`\n\r\n`);
          return;
        }
        if (body.method === 'tools/list' && body.params?.cursor === 'truncated') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progressToken: 'p-trunc', progress: 1, total: 2 },
            })}\n\n`,
          );
          return;
        }
        res.writeHead(404).end();
      })().catch(() => res.destroy());
    });
    const upstreamPort = await listen(upstream);
    trackCleanup(() => closeServer(upstream));

    const harness = await createMountHarness({
      server: { url: `http://127.0.0.1:${upstreamPort}/mcp` },
      trackCleanup,
    });

    // 1. Cross-chunk \r + \n SSE response parses cleanly
    const splitRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'crlf-1',
        method: 'tools/list',
        params: { cursor: 'split-crlf', _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/list',
      },
    );
    expect(splitRes.status).toBe(200);
    expect(await splitRes.json()).toEqual({
      jsonrpc: '2.0',
      id: 'crlf-1',
      result: { tools: [{ name: 'crlf_tool' }] },
    });

    // 2. Truncated SSE stream closing after progress notification without terminal reply fails
    const truncRes = await harness.post(
      {
        jsonrpc: '2.0',
        id: 'trunc-1',
        method: 'tools/list',
        params: { cursor: 'truncated', _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/list',
      },
    );
    expect(truncRes.status).toBe(200);
    const frames = parseSseMessages(await truncRes.text());
    expect(frames).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'p-trunc', progress: 1, total: 2 },
      },
      {
        jsonrpc: '2.0',
        id: 'trunc-1',
        error: {
          code: -32603,
          message: 'MCP server process failed',
        },
      },
    ]);
  });
});
