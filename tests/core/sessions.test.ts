import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeMount } from '@mcp-gateway/core/adapter';
import { BACKEND_CAPACITY_ERROR } from '@mcp-gateway/core/limits';
import { readWhile } from '@mcp-gateway/core/sessions';
import {
  closeServer,
  createMountHarness,
  listen,
  parseSseMessages,
  readBodyText,
  registerAsyncCleanups,
} from '../helpers/http-mount';

const PROTOCOL_VERSION = '2025-11-25';

const STDIO_FIXTURE_SCRIPT = `
const receivedIds = Object.create(null);
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let newline;
  while ((newline = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, newline).trim();
    buf = buf.slice(newline + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '${PROTOCOL_VERSION}',
          capabilities: { tools: {} },
          serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
          instructions: String(process.pid),
        },
      });
    } else if (msg.method === 'ping') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { pid: process.pid },
      });
    } else if (msg.method === 'tools/list') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo tool',
              inputSchema: { type: 'object' },
            },
          ],
        },
      });
    } else if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const key = String(msg.id);
      receivedIds[key] = (receivedIds[key] || 0) + 1;
      if (name === 'slow') {
        const progressToken = msg.params && msg.params._meta && msg.params._meta.progressToken;
        write({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, progress: 1, total: 2 },
        });
      } else if (name === 'hang') {
        // Intentionally never reply.
      } else if (name === 'stats') {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(receivedIds) }] },
        });
      } else if (name === 'emit_stderr') {
        process.stderr.write('SECRET_STDERR_LINE_1\\n');
        setTimeout(() => {
          process.stderr.write('SECRET_STDERR_LINE_2\\n');
          write({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'stderr-emitted' }] },
          });
        }, 25);
      } else if (name === 'crash') {
        process.exit(1);
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

const MARKER_SPAWN_SCRIPT = `
const fs = require('node:fs');
if (process.env.SPAWN_MARKER_FILE) {
  fs.writeFileSync(process.env.SPAWN_MARKER_FILE, 'spawned');
}
process.exit(0);
`;

const isProcessGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

const waitFor = async (predicate: () => boolean, description: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for: ${description}`);
};

const parseResponseMessages = async (response: Response): Promise<unknown[]> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return parseSseMessages(await response.text());
  }
  if (contentType.includes('application/json')) {
    return [await response.json()];
  }
  return [];
};

const readUntilSseMessage = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 5_000,
) => {
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => {
        throw new Error('Timed out waiting for SSE event');
      }),
    ]);
    if (next.done) throw new Error('SSE stream ended before receiving an event');
    buffer += decoder.decode(next.value, { stream: true });
    const messages = parseSseMessages(buffer);
    if (messages.length > 0) return messages[0];
  }
  throw new Error('Timed out waiting for SSE event');
};

const initializeBody = (id: string | number = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'sessions-test', version: '1.0.0' },
  },
});

const postJson = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) =>
  fetch(url, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(5_000),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });

const trackCleanup = registerAsyncCleanups();

describe('src/core/sessions.ts — Step 1: session-based MCP lifecycle', () => {
  test('stdio session: initialize, POST calls, GET event stream, and DELETE teardown', async () => {
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 1,
    });

    const initResponse = await postJson(harness.url, initializeBody(1));
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const initMessages = await parseResponseMessages(initResponse);
    expect(initMessages).toHaveLength(1);
    const initReply = initMessages[0] as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string };
        instructions: string;
      };
    };
    expect(initReply.id).toBe(1);
    expect(initReply.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(initReply.result.serverInfo.name).toBe('stdio-fixture');

    const childPid = Number(initReply.result.instructions);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(isProcessGone(childPid)).toBe(false);

    // Active session holds both ResourceAdmission and sessionAdmission leases.
    expect(harness.admission.acquire()).toBeUndefined();
    expect(harness.sessionAdmission.acquire()).toBeUndefined();

    // Send notifications/initialized on the allocated session.
    const initializedResponse = await postJson(
      harness.url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(initializedResponse.status).toBe(202);

    // Subsequent POST requests route to the same session and backend process.
    const pingResponse = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      {
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(pingResponse.status).toBe(200);
    const pingMessages = await parseResponseMessages(pingResponse);
    expect(pingMessages).toEqual([{ jsonrpc: '2.0', id: 2, result: { pid: childPid } }]);

    const toolsResponse = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      {
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(toolsResponse.status).toBe(200);
    const toolsMessages = await parseResponseMessages(toolsResponse);
    expect(toolsMessages).toMatchObject([
      {
        jsonrpc: '2.0',
        id: 3,
        result: { tools: [{ name: 'echo' }] },
      },
    ]);

    // Open GET SSE event stream on the active session.
    const sseAbort = new AbortController();
    const sseResponse = await fetch(harness.url, {
      method: 'GET',
      signal: sseAbort.signal,
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    });
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get('content-type')).toContain('text/event-stream');
    const sseReader = sseResponse.body?.getReader();

    // DELETE closes the session, ends the SSE stream, terminates the child process group,
    // and releases both admission leases.
    const deleteResponse = await fetch(harness.url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
      headers: {
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    });
    expect(deleteResponse.status).toBe(200);

    if (sseReader) {
      const next = await Promise.race([
        sseReader.read(),
        Bun.sleep(2_000).then(() => ({ done: false, value: undefined })),
      ]);
      expect(next.done).toBe(true);
      sseReader.releaseLock();
    }
    sseAbort.abort();

    await waitFor(() => isProcessGone(childPid), 'stdio child process group termination');
    await waitFor(() => {
      const resourceLease = harness.admission.acquire();
      if (!resourceLease) return false;
      const sessionLease = harness.sessionAdmission.acquire();
      if (!sessionLease) {
        resourceLease.release();
        return false;
      }
      sessionLease.release();
      resourceLease.release();
      return true;
    }, 'release of ResourceAdmission and sessionAdmission leases');

    // Subsequent requests with the closed Mcp-Session-Id return 404.
    const postAfterDelete = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 4, method: 'ping' },
      { 'mcp-session-id': sessionId as string },
    );
    expect(postAfterDelete.status).toBe(404);

    const getAfterDelete = await fetch(harness.url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId as string,
      },
    });
    expect(getAfterDelete.status).toBe(404);

    const deleteAgain = await fetch(harness.url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
      headers: { 'mcp-session-id': sessionId as string },
    });
    expect(deleteAgain.status).toBe(404);
  });

  test('HTTP upstream session: initialize, POST routing, upstream headers, and DELETE cleanup', async () => {
    const upstreamSessionId = 'upstream-session-1';
    const seenRequests: Array<{
      method: string;
      sessionId: string | undefined;
      protocolVersion: string | undefined;
      customHeader: string | undefined;
      rpcMethod?: string;
    }> = [];
    const deletedSessions: Array<string | undefined> = [];

    const upstream = createServer((req, res) => {
      void (async () => {
        if (req.method === 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (req.method === 'DELETE') {
          const sid =
            typeof req.headers['mcp-session-id'] === 'string'
              ? req.headers['mcp-session-id']
              : undefined;
          deletedSessions.push(sid);
          res.statusCode = 200;
          res.end();
          return;
        }
        const raw = await readBodyText(req);
        const msg = JSON.parse(raw) as { id?: string | number; method?: string };
        seenRequests.push({
          method: req.method ?? '',
          sessionId:
            typeof req.headers['mcp-session-id'] === 'string'
              ? req.headers['mcp-session-id']
              : undefined,
          protocolVersion:
            typeof req.headers['mcp-protocol-version'] === 'string'
              ? req.headers['mcp-protocol-version']
              : undefined,
          customHeader:
            typeof req.headers['x-upstream-token'] === 'string'
              ? req.headers['x-upstream-token']
              : undefined,
          rpcMethod: msg.method,
        });
        if (msg.method === 'initialize') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': upstreamSessionId,
          });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'http-upstream', version: '1.0.0' },
              },
            }),
          );
          return;
        }
        if (msg.method === 'notifications/initialized') {
          res.statusCode = 202;
          res.end();
          return;
        }
        if (msg.method === 'ping') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pong: true } }));
          return;
        }
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  {
                    name: 'remote_echo',
                    description: 'Remote tool',
                    inputSchema: { type: 'object' },
                  },
                ],
              },
            }),
          );
          return;
        }
        res.statusCode = 400;
        res.end();
      })();
    });

    const upstreamPort = await listen(upstream);
    trackCleanup(() => closeServer(upstream));

    const harness = await createMountHarness({
      server: {
        url: `http://127.0.0.1:${upstreamPort}/mcp`,
        headers: { 'x-upstream-token': 'upstream-secret-value' },
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 1,
    });

    const initResponse = await postJson(harness.url, initializeBody(10));
    expect(initResponse.status).toBe(200);
    const gatewaySessionId = initResponse.headers.get('mcp-session-id');
    expect(gatewaySessionId).toBeTruthy();
    expect(gatewaySessionId).not.toBe(upstreamSessionId);

    const initMessages = await parseResponseMessages(initResponse);
    expect(initMessages).toMatchObject([
      {
        jsonrpc: '2.0',
        id: 10,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'http-upstream', version: '1.0.0' },
        },
      },
    ]);

    const initializedResponse = await postJson(
      harness.url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        'mcp-session-id': gatewaySessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(initializedResponse.status).toBe(202);

    const pingResponse = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 11, method: 'ping' },
      {
        'mcp-session-id': gatewaySessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(pingResponse.status).toBe(200);
    expect(await parseResponseMessages(pingResponse)).toEqual([
      { jsonrpc: '2.0', id: 11, result: { pong: true } },
    ]);

    const toolsResponse = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 12, method: 'tools/list' },
      {
        'mcp-session-id': gatewaySessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(toolsResponse.status).toBe(200);
    expect(await parseResponseMessages(toolsResponse)).toMatchObject([
      {
        jsonrpc: '2.0',
        id: 12,
        result: { tools: [{ name: 'remote_echo' }] },
      },
    ]);

    // Verify upstream received the configured header, its own session ID, and negotiated protocol version.
    const pingAtUpstream = seenRequests.find((entry) => entry.rpcMethod === 'ping');
    expect(pingAtUpstream).toEqual({
      method: 'POST',
      sessionId: upstreamSessionId,
      protocolVersion: PROTOCOL_VERSION,
      customHeader: 'upstream-secret-value',
      rpcMethod: 'ping',
    });

    const deleteResponse = await fetch(harness.url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
      headers: {
        'mcp-session-id': gatewaySessionId as string,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    });
    expect(deleteResponse.status).toBe(200);

    await waitFor(
      () => deletedSessions.includes(upstreamSessionId),
      'upstream DELETE session termination',
    );
    await waitFor(() => {
      const resourceLease = harness.admission.acquire();
      if (!resourceLease) return false;
      const sessionLease = harness.sessionAdmission.acquire();
      if (!sessionLease) {
        resourceLease.release();
        return false;
      }
      sessionLease.release();
      resourceLease.release();
      return true;
    }, 'release of upstream session leases');

    const afterDelete = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 13, method: 'ping' },
      { 'mcp-session-id': gatewaySessionId as string },
    );
    expect(afterDelete.status).toBe(404);
  });

  test('rejects missing Mcp-Session-Id with 400 and unknown Mcp-Session-Id with 404', async () => {
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
      },
    });

    // POST non-initialize without Mcp-Session-Id -> 400 JSON-RPC -32000
    const postMissing = await postJson(harness.url, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(postMissing.status).toBe(400);
    expect(await postMissing.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    });

    // GET and DELETE without Mcp-Session-Id -> 400
    const getMissing = await fetch(harness.url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'text/event-stream' },
    });
    expect(getMissing.status).toBe(400);
    expect(await getMissing.text()).toBe('Invalid or missing session ID');

    const deleteMissing = await fetch(harness.url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    });
    expect(deleteMissing.status).toBe(400);
    expect(await deleteMissing.text()).toBe('Invalid or missing session ID');

    // POST, GET, and DELETE with unknown Mcp-Session-Id -> 404
    const unknownId = '00000000-0000-0000-0000-000000000000';

    const postUnknown = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { 'mcp-session-id': unknownId },
    );
    expect(postUnknown.status).toBe(404);
    expect(await postUnknown.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found',
      },
      id: null,
    });

    const getUnknown = await fetch(harness.url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': unknownId,
      },
    });
    expect(getUnknown.status).toBe(404);
    expect(await getUnknown.text()).toBe('Session not found');

    const deleteUnknown = await fetch(harness.url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
      headers: { 'mcp-session-id': unknownId },
    });
    expect(deleteUnknown.status).toBe(404);
    expect(await deleteUnknown.text()).toBe('Session not found');
  });
});

describe('src/core/sessions.ts — Step 2: duplicate ID guard, cancelled-call overload, admission cap, and stderr suppression', () => {
  test('refuses duplicate in-flight request id with -32600 without forwarding or double-charging', async () => {
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
      },
      callLimit: 2,
    });

    const initResponse = await postJson(harness.url, initializeBody(1));
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id') as string;
    expect(sessionId).toBeTruthy();
    await parseResponseMessages(initResponse);

    const sessionHeaders = {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };

    // Start slow request id: 42 and wait until the child confirms receipt via progress event.
    const slowAbort = new AbortController();
    const slowResponse = await postJson(
      harness.url,
      {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'slow',
          arguments: {},
          _meta: { progressToken: 'tok-42' },
        },
      },
      sessionHeaders,
      slowAbort.signal,
    );
    expect(slowResponse.status).toBe(200);
    const slowReader = slowResponse.body?.getReader();
    expect(slowReader).toBeDefined();

    try {
      const progressEvent = await readUntilSseMessage(
        slowReader as ReadableStreamDefaultReader<Uint8Array>,
      );
      expect(progressEvent).toMatchObject({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok-42' },
      });

      // Send a second concurrent request with the same id: 42 on the same session.
      const duplicateResponse = await postJson(
        harness.url,
        {
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: { name: 'slow', arguments: {} },
        },
        sessionHeaders,
      );
      expect(duplicateResponse.status).toBe(200);
      const duplicateMessages = await parseResponseMessages(duplicateResponse);
      expect(duplicateMessages).toEqual([
        {
          jsonrpc: '2.0',
          id: 42,
          error: {
            code: -32600,
            message: 'A request with this id is already in flight in this session.',
          },
        },
      ]);

      // Verify id: 42 was NOT double-charged: 1 of 2 BackendCalls slots remains free.
      const probeOwner = harness.calls.owner();
      expect(harness.calls.admit(probeOwner, 'probe')).toBe(true);
      expect(harness.calls.settleOwner(probeOwner)).toBe(1);

      // Query backend stats to confirm id: 42 was forwarded only once.
      const statsResponse = await postJson(
        harness.url,
        {
          jsonrpc: '2.0',
          id: 43,
          method: 'tools/call',
          params: { name: 'stats', arguments: {} },
        },
        sessionHeaders,
      );
      expect(statsResponse.status).toBe(200);
      const statsMessages = (await parseResponseMessages(statsResponse)) as Array<{
        result: { content: Array<{ text: string }> };
      }>;
      const receivedIds = JSON.parse(statsMessages[0]?.result.content[0]?.text ?? '{}') as Record<
        string,
        number
      >;
      expect(receivedIds['42']).toBe(1);
    } finally {
      slowAbort.abort();
      await slowReader?.cancel().catch(() => {});
      slowReader?.releaseLock();
    }
  });

  test('refuses non-duplicate call with BACKEND_CAPACITY_ERROR (1001) when BackendCalls is exhausted', async () => {
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
      },
      callLimit: 1,
    });

    const initResponse = await postJson(harness.url, initializeBody(1));
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id') as string;
    await parseResponseMessages(initResponse);

    const sessionHeaders = {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };

    const hangAbort = new AbortController();
    const hangResponse = await postJson(
      harness.url,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'hang', arguments: {} },
      },
      sessionHeaders,
      hangAbort.signal,
    );
    expect(hangResponse.status).toBe(200);

    try {
      const overflowResponse = await postJson(
        harness.url,
        { jsonrpc: '2.0', id: 11, method: 'ping' },
        sessionHeaders,
      );
      expect(overflowResponse.status).toBe(200);
      expect(await parseResponseMessages(overflowResponse)).toEqual([
        {
          jsonrpc: '2.0',
          id: 11,
          error: BACKEND_CAPACITY_ERROR,
        },
      ]);
    } finally {
      hangAbort.abort();
      await hangResponse.body?.cancel().catch(() => {});
    }
  });

  test('closes overloaded session at MAX_CANCELLED_CALLS (4), terminates backend, and frees all 4 BackendCalls slots', async () => {
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 1,
      callLimit: 4,
    });

    const initResponse = await postJson(harness.url, initializeBody(100));
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id') as string;
    const initMessages = (await parseResponseMessages(initResponse)) as Array<{
      result: { instructions: string };
    }>;
    const childPid = Number(initMessages[0]?.result.instructions);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);

    const sessionHeaders = {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };

    // Send 4 requests (id: 1..4) that never receive a reply.
    const aborters: AbortController[] = [];
    const responses: Response[] = [];
    try {
      for (const id of [1, 2, 3, 4]) {
        const controller = new AbortController();
        aborters.push(controller);
        const response = await postJson(
          harness.url,
          {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'hang', arguments: {} },
          },
          sessionHeaders,
          controller.signal,
        );
        expect(response.status).toBe(200);
        responses.push(response);
      }

      // All 4 BackendCalls slots are charged while id 1..4 are unanswered.
      const probeOwner = harness.calls.owner();
      expect(harness.calls.admit(probeOwner, 'overflow')).toBe(false);

      // Cancel requests 1..3: slots stay charged and session stays open.
      for (const requestId of [1, 2, 3]) {
        const cancelResponse = await postJson(
          harness.url,
          {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId, reason: 'client cancelled' },
          },
          sessionHeaders,
        );
        expect(cancelResponse.status).toBe(202);
      }

      // After 3 cancellations (< MAX_CANCELLED_CALLS), backend is still running and slots remain charged.
      expect(isProcessGone(childPid)).toBe(false);
      expect(harness.calls.admit(probeOwner, 'still-full')).toBe(false);

      // 4th cancellation crosses MAX_CANCELLED_CALLS (4) and triggers overload closure.
      const fourthCancel = await postJson(
        harness.url,
        {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 4, reason: 'client cancelled' },
        },
        sessionHeaders,
      );
      expect(fourthCancel.status).toBe(202);

      // Session is removed, child terminates, all 4 BackendCalls slots and leases are released.
      await waitFor(() => isProcessGone(childPid), 'overloaded session child process termination');

      await waitFor(() => {
        const checkOwner = harness.calls.owner();
        const admitted: number[] = [];
        for (const id of [1, 2, 3, 4]) {
          if (!harness.calls.admit(checkOwner, id)) break;
          admitted.push(id);
        }
        harness.calls.settleOwner(checkOwner);
        return admitted.length === 4;
      }, 'release of all 4 charged BackendCalls slots after overload cleanup');

      await waitFor(() => {
        const resourceLease = harness.admission.acquire();
        if (!resourceLease) return false;
        const sessionLease = harness.sessionAdmission.acquire();
        if (!sessionLease) {
          resourceLease.release();
          return false;
        }
        sessionLease.release();
        resourceLease.release();
        return true;
      }, 'release of admission leases after overload closure');

      const afterOverload = await postJson(
        harness.url,
        { jsonrpc: '2.0', id: 5, method: 'ping' },
        sessionHeaders,
      );
      expect(afterOverload.status).toBe(404);

      const warnEntries = harness.logs
        .read({ after: 0 })
        .entries.filter(
          (entry) =>
            entry.level === 'warn' &&
            entry.text.includes('Session: closed after too many unanswered cancelled calls.'),
        );
      expect(warnEntries.length).toBeGreaterThanOrEqual(1);
    } finally {
      for (const controller of aborters) controller.abort();
      for (const response of responses) await response.body?.cancel().catch(() => {});
    }
  });

  test('fails pending calls with -32603 and releases leases when stdio child exits unexpectedly', async () => {
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 1,
      callLimit: 1,
    });

    const initResponse = await postJson(harness.url, initializeBody(1));
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id') as string;
    await parseResponseMessages(initResponse);

    const crashResponse = await postJson(
      harness.url,
      {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'crash', arguments: {} },
      },
      {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(crashResponse.status).toBe(200);
    expect(await parseResponseMessages(crashResponse)).toEqual([
      {
        jsonrpc: '2.0',
        id: 99,
        error: {
          code: -32603,
          message: 'MCP server process failed',
        },
      },
    ]);

    await waitFor(() => {
      const resourceLease = harness.admission.acquire();
      if (!resourceLease) return false;
      const sessionLease = harness.sessionAdmission.acquire();
      if (!sessionLease) {
        resourceLease.release();
        return false;
      }
      const owner = harness.calls.owner();
      const callOk = harness.calls.admit(owner, 'after-crash');
      harness.calls.settleOwner(owner);
      sessionLease.release();
      resourceLease.release();
      return callOk;
    }, 'release of leases and call budget after unexpected child exit');

    expect(harness.diagnostics.some((entry) => entry.includes('code 1'))).toBe(true);
  });

  test('rejects initialize without spawning a child when sessionAdmission has 0 remaining leases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bear-mcp-sessions-cap-'));
    trackCleanup(() => rm(dir, { recursive: true, force: true }));
    const markerFile = join(dir, 'spawned.marker');

    // Note: createMount() maps CapacityError from exhausted sessionAdmission/admission to HTTP 429
    // (and returns 503 when the mount is closing).
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', MARKER_SPAWN_SCRIPT],
        env: { SPAWN_MARKER_FILE: markerFile },
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 0,
    });

    const response = await postJson(harness.url, initializeBody(1));
    expect(response.status).toBe(429);
    expect(response.headers.get('mcp-session-id')).toBeNull();

    // Confirm no child process was spawned and the ResourceAdmission lease was not leaked.
    await Bun.sleep(50);
    expect(existsSync(markerFile)).toBe(false);
    const resourceLease = harness.admission.acquire();
    expect(resourceLease).toBeDefined();
    resourceLease?.release();

    // Closing the mount rejects subsequent initialize attempts with 503 without spawning.
    await closeMount(harness.mount);
    const closingResponse = await postJson(harness.url, initializeBody(2));
    expect(closingResponse.status).toBe(503);
    expect(existsSync(markerFile)).toBe(false);
  });

  test('logTraffic: false suppresses raw child stderr while logTraffic: true forwards it', async () => {
    const suppressedHarness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
        logTraffic: false,
      },
    });

    const suppressedInit = await postJson(suppressedHarness.url, initializeBody(1));
    expect(suppressedInit.status).toBe(200);
    const suppressedSessionId = suppressedInit.headers.get('mcp-session-id') as string;
    await parseResponseMessages(suppressedInit);

    const suppressedCall = await postJson(
      suppressedHarness.url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'emit_stderr', arguments: {} },
      },
      {
        'mcp-session-id': suppressedSessionId,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(suppressedCall.status).toBe(200);
    await parseResponseMessages(suppressedCall);

    const suppressedEntries = suppressedHarness.logs.read({ after: 0 }).entries;
    const suppressedStderr = suppressedEntries.filter((entry) => entry.source === 'stderr');
    expect(suppressedStderr).toHaveLength(1);
    expect(suppressedStderr[0]?.text).toContain(
      'Child stderr output suppressed (enable traffic logging or inspect redacted diagnostics).',
    );
    for (const entry of suppressedEntries) {
      expect(entry.text).not.toContain('SECRET_STDERR_LINE_1');
      expect(entry.text).not.toContain('SECRET_STDERR_LINE_2');
    }
    expect(suppressedHarness.diagnostics).toEqual([]);

    const trafficHarness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
        logTraffic: true,
      },
    });

    const trafficInit = await postJson(trafficHarness.url, initializeBody(1));
    expect(trafficInit.status).toBe(200);
    const trafficSessionId = trafficInit.headers.get('mcp-session-id') as string;
    await parseResponseMessages(trafficInit);

    const trafficCall = await postJson(
      trafficHarness.url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'emit_stderr', arguments: {} },
      },
      {
        'mcp-session-id': trafficSessionId,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
    );
    expect(trafficCall.status).toBe(200);
    await parseResponseMessages(trafficCall);

    const combinedStderr = trafficHarness.logs
      .read({ after: 0 })
      .entries.filter((entry) => entry.source === 'stderr')
      .map((entry) => entry.text)
      .join('\n');
    expect(combinedStderr).toContain('SECRET_STDERR_LINE_1');
    expect(combinedStderr).toContain('SECRET_STDERR_LINE_2');
    expect(combinedStderr).not.toContain('Child stderr output suppressed');
  });

  test('readWhile pauses response body pulls until backpressure drains and passes null bodies through', async () => {
    const empty = new Response(null, { status: 204 });
    expect(readWhile(empty, () => undefined)).toBe(empty);

    let releaseDrain: (() => void) | undefined;
    let waitCalls = 0;
    const gate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });

    const encoder = new TextEncoder();
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('chunk-1-'));
          controller.enqueue(encoder.encode('chunk-2'));
          controller.close();
        },
      }),
      {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      },
    );

    const held = readWhile(source, () => {
      waitCalls++;
      return waitCalls === 1 ? gate : undefined;
    });
    expect(held.status).toBe(200);
    expect(held.headers.get('content-type')).toBe('text/plain');

    let finished = false;
    const textPromise = held.text().then((value) => {
      finished = true;
      return value;
    });

    await Bun.sleep(30);
    expect(finished).toBe(false);
    releaseDrain?.();

    expect(await textPromise).toBe('chunk-1-chunk-2');
    expect(waitCalls).toBeGreaterThanOrEqual(2);
  });

  test('automatically synthesizes notifications/cancelled on client HTTP disconnect and closes overloaded session at MAX_CANCELLED_CALLS (4)', async () => {
    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', STDIO_FIXTURE_SCRIPT],
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 1,
      callLimit: 4,
    });

    const initResponse = await postJson(harness.url, initializeBody(1));
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id') as string;
    const initMessages = (await parseResponseMessages(initResponse)) as Array<{
      result: { instructions: string };
    }>;
    const childPid = Number(initMessages[0]?.result.instructions);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);

    const sessionHeaders = {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };

    for (const id of [1, 2, 3, 4]) {
      const controller = new AbortController();
      const response = await postJson(
        harness.url,
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'hang', arguments: {} },
        },
        sessionHeaders,
        controller.signal,
      );
      expect(response.status).toBe(200);
      controller.abort();
      await response.body?.cancel().catch(() => {});
    }

    await waitFor(
      () => isProcessGone(childPid),
      'overloaded session child process termination after 4 client HTTP disconnects',
    );

    await waitFor(() => {
      const checkOwner = harness.calls.owner();
      const admitted: number[] = [];
      for (const id of [1, 2, 3, 4]) {
        if (!harness.calls.admit(checkOwner, id)) break;
        admitted.push(id);
      }
      harness.calls.settleOwner(checkOwner);
      return admitted.length === 4;
    }, 'release of all 4 BackendCalls slots after disconnect overload');

    await waitFor(() => {
      const resourceLease = harness.admission.acquire();
      if (!resourceLease) return false;
      const sessionLease = harness.sessionAdmission.acquire();
      if (!sessionLease) {
        resourceLease.release();
        return false;
      }
      sessionLease.release();
      resourceLease.release();
      return true;
    }, 'release of admission and sessionAdmission leases after disconnect overload');

    const pingAfter = await postJson(
      harness.url,
      { jsonrpc: '2.0', id: 5, method: 'ping' },
      sessionHeaders,
    );
    expect(pingAfter.status).toBe(404);

    const warnEntries = harness.logs
      .read({ after: 0 })
      .entries.filter(
        (entry) =>
          entry.level === 'warn' &&
          entry.text.includes('Session: closed after too many unanswered cancelled calls.'),
      );
    expect(warnEntries.length).toBeGreaterThanOrEqual(1);
  });

  test('aborting an in-flight initialize HTTP request closes the half-opened session and releases admission leases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bear-mcp-abandoned-init-'));
    trackCleanup(() => rm(dir, { recursive: true, force: true }));
    const pidFile = join(dir, 'init-child.pid');

    const delayedInitScript = `
const fs = require('node:fs');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('"initialize"')) {
    fs.writeFileSync(process.env.INIT_PID_FILE, String(process.pid));
  }
});
process.stdin.resume();
`;

    const harness = await createMountHarness({
      server: {
        command: process.execPath,
        args: ['-e', delayedInitScript],
        env: { INIT_PID_FILE: pidFile },
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 1,
    });

    const abortController = new AbortController();
    const initPromise = postJson(harness.url, initializeBody(1), {}, abortController.signal).catch(
      () => undefined,
    );

    await waitFor(() => existsSync(pidFile), 'child to receive initialize request');
    abortController.abort();
    await initPromise;

    await waitFor(() => {
      const resourceLease = harness.admission.acquire();
      if (!resourceLease) return false;
      const sessionLease = harness.sessionAdmission.acquire();
      if (!sessionLease) {
        resourceLease.release();
        return false;
      }
      sessionLease.release();
      resourceLease.release();
      return true;
    }, 'release of admission and sessionAdmission leases after abandoned initialize');
  });

  test('fails initialize cleanly and releases leases when upstream HTTP initialize omits protocolVersion', async () => {
    const upstream = createServer((req, res) => {
      void (async () => {
        if (req.method === 'DELETE') {
          res.statusCode = 200;
          res.end();
          return;
        }
        if (req.method === 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const raw = await readBodyText(req);
        const msg = JSON.parse(raw) as { id?: string | number; method?: string };
        if (msg.method === 'initialize') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'missing-version-session',
          });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                capabilities: {},
              },
            }),
          );
          return;
        }
        res.statusCode = 400;
        res.end();
      })();
    });

    const upstreamPort = await listen(upstream);
    trackCleanup(() => closeServer(upstream));

    const harness = await createMountHarness({
      server: {
        url: `http://127.0.0.1:${upstreamPort}/mcp`,
        legacyProtocol: true,
      },
      admissionLimit: 1,
      sessionLimit: 1,
    });

    const initResponse = await postJson(harness.url, initializeBody(1));
    const messages = (await parseResponseMessages(initResponse)) as Array<{
      error?: { code: number; message: string };
    }>;
    expect(messages[0]?.error?.code).toBe(-32603);

    await waitFor(
      () =>
        harness.logs
          .read({ after: 0 })
          .entries.some((entry) =>
            entry.text.includes('Upstream initialization has no protocol version.'),
          ),
      'log entry for missing upstream protocolVersion',
    );

    await waitFor(() => {
      const resourceLease = harness.admission.acquire();
      if (!resourceLease) return false;
      const sessionLease = harness.sessionAdmission.acquire();
      if (!sessionLease) {
        resourceLease.release();
        return false;
      }
      sessionLease.release();
      resourceLease.release();
      return true;
    }, 'release of admission and sessionAdmission leases after upstream missing protocolVersion');
  });
});
