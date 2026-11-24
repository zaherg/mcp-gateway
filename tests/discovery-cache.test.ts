import { expect, test } from 'bun:test';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { parseConfig, resolveKeys } from '@mcp-gateway/core/config';
import { GatewayIngress } from '@mcp-gateway/core/ingress';
import { isRecord } from '@mcp-gateway/shared/config-document';

const VERSION = '2026-07-28';
const TOKEN = 'discovery-fixture-token-not-a-real-secret';
const DISCOVERY_BYTES = 64 * 1024;

type Format = 'json' | 'sse';
type Reply =
  | 'supported'
  | 'unsupported'
  | 'malformed'
  | 'invalid-utf8'
  | 'at-limit'
  | 'oversized'
  | 'reset-before-headers'
  | 'reset-mid-body'
  | 'unavailable';

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Expected a TCP listener.'));
      else resolve(address.port);
    });
  });

const close = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
};

const discoveryReply = (res: ServerResponse, id: string | number, reply: Reply, format: Format) => {
  if (reply === 'reset-before-headers') {
    res.destroy();
    return;
  }
  const encode = (json: string) => Buffer.from(format === 'sse' ? `data: ${json}\n\n` : json);
  const result = {
    jsonrpc: '2.0',
    id,
    result: { supportedVersions: reply === 'unsupported' ? ['2025-11-25'] : [VERSION], note: '' },
  };
  let body = encode(JSON.stringify(result));
  if (reply === 'malformed') body = encode('{');
  if (reply === 'invalid-utf8') {
    // Replacement decoding would make this a valid, supported reply. Fatal decoding must refuse it.
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
    // Let fetch receive the headers and enter its body reader before resetting the connection.
    const timer = setTimeout(() => res.destroy(), 100);
    res.once('close', () => clearTimeout(timer));
  } else res.end(body);
};

interface Fixture {
  request(): Promise<{ status: number; body: unknown }>;
  recover(): void;
  discoveries(): number;
  forwarded(): number;
}

const withGateway = async (
  reply: Reply,
  format: Format,
  check: (fixture: Fixture) => Promise<void>,
) => {
  let discoveries = 0;
  let forwarded = 0;
  let recovered = false;
  const errors: unknown[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      let text = '';
      for await (const chunk of req) text += chunk.toString();
      const message: unknown = JSON.parse(text);
      if (!isRecord(message) || (typeof message.id !== 'string' && typeof message.id !== 'number'))
        throw new Error('The fixture expected a JSON-RPC request with an id.');
      if (message.method === 'server/discover') {
        discoveries++;
        discoveryReply(res, message.id, recovered ? 'supported' : reply, format);
      } else {
        if (message.method !== 'ping') throw new Error('The fixture expected ping.');
        forwarded++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      }
    })().catch((error) => {
      errors.push(error);
      res.destroy();
    });
  });
  const reservation = createServer();
  let gateway: GatewayIngress | undefined;
  try {
    const upstreamPort = await listen(upstream);
    const port = await listen(reservation);
    await close(reservation);
    const config = resolveKeys(
      parseConfig(
        JSON.stringify({
          gateway: { host: '127.0.0.1', port, token: TOKEN },
          mcpServers: { probe: { url: `http://127.0.0.1:${upstreamPort}/mcp` } },
        }),
        {},
      ),
      new Map(),
    );
    gateway = await GatewayIngress.open(config, (error) => errors.push(error));
    await check({
      request: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/mcp/probe`, {
          method: 'POST',
          signal: AbortSignal.timeout(3000),
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': VERSION,
            'mcp-method': 'ping',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'ping',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': VERSION,
                'io.modelcontextprotocol/clientInfo': { name: 'discovery-fixture', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      recover: () => {
        recovered = true;
      },
      discoveries: () => discoveries,
      forwarded: () => forwarded,
    });
  } finally {
    await Promise.all([gateway?.close(), close(upstream), close(reservation)]);
  }
  expect(errors).toEqual([]);
};

const expectRefusal = (response: { status: number; body: unknown }) => {
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32600 } });
};
const expectSuccess = (response: { status: number; body: unknown }) => {
  expect(response).toEqual({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
};

for (const format of ['json', 'sse'] as const) {
  for (const reply of ['reset-before-headers', 'reset-mid-body', 'unavailable'] as const) {
    test(`${format}: ${reply} is retried immediately, then success is cached`, async () => {
      await withGateway(reply, format, async (fixture) => {
        expectRefusal(await fixture.request());
        expect(fixture.discoveries()).toBe(1);
        expect(fixture.forwarded()).toBe(0);
        fixture.recover();
        expectSuccess(await fixture.request());
        expect(fixture.discoveries()).toBe(2);
        expect(fixture.forwarded()).toBe(1);
        expectSuccess(await fixture.request());
        expect(fixture.discoveries()).toBe(2);
        expect(fixture.forwarded()).toBe(2);
      });
    });
  }
  for (const reply of ['unsupported', 'malformed', 'invalid-utf8', 'oversized'] as const) {
    test(`${format}: ${reply} stays refused and negative-cached`, async () => {
      await withGateway(reply, format, async (fixture) => {
        expectRefusal(await fixture.request());
        fixture.recover();
        expectRefusal(await fixture.request());
        expect(fixture.discoveries()).toBe(1);
        expect(fixture.forwarded()).toBe(0);
      });
    });
  }
  test(`${format}: a supported reply at the 64 KiB limit is accepted`, async () => {
    await withGateway('at-limit', format, async (fixture) => {
      expectSuccess(await fixture.request());
      expect(fixture.discoveries()).toBe(1);
      expect(fixture.forwarded()).toBe(1);
    });
  });
}
