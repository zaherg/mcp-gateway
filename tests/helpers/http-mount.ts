import { afterEach } from 'bun:test';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  closeMount,
  createMount,
  type GatewayMount,
  MODERN_VERSION,
} from '@mcp-gateway/core/adapter';
import {
  BackendCalls,
  MAX_BACKEND_MESSAGE_BYTES,
  ResourceAdmission,
  readRequestBody,
} from '@mcp-gateway/core/limits';
import { LogBuffer } from '@mcp-gateway/core/logs';
import type { GatewayRequest } from '@mcp-gateway/core/sessions';
import type { HttpServerConfig, StdioServerConfig } from '@mcp-gateway/shared/types';

export const encodeBase64Header = (value: string): string =>
  `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;

export const modernMeta = (version: string = MODERN_VERSION): Record<string, unknown> => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'adapter-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

export const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Expected a TCP listener.'));
      else resolve(address.port);
    });
  });

export const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
};

export const readBodyText = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const parseSseMessages = (raw: string): unknown[] => {
  const messages: unknown[] = [];
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());
    if (dataLines.length > 0) {
      messages.push(JSON.parse(dataLines.join('\n')));
    }
  }
  return messages;
};

export const registerAsyncCleanups = (): ((fn: () => Promise<void>) => void) => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });
  return (fn: () => Promise<void>) => {
    cleanups.push(fn);
  };
};

export interface MountHarness {
  url: string;
  mount: GatewayMount;
  admission: ResourceAdmission;
  sessionAdmission: ResourceAdmission;
  calls: BackendCalls;
  logs: LogBuffer;
  diagnostics: string[];
  post(body: unknown, headers?: Record<string, string>): Promise<Response>;
  request(
    method: string,
    options?: {
      body?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

const defaultTrackCleanup = registerAsyncCleanups();

export const createMountHarness = async (options: {
  name?: string;
  server: (StdioServerConfig | HttpServerConfig) & { logTraffic?: boolean };
  admission?: ResourceAdmission;
  calls?: BackendCalls;
  sessionAdmission?: ResourceAdmission;
  logs?: LogBuffer;
  admissionLimit?: number;
  sessionLimit?: number;
  callLimit?: number;
  trackCleanup?: (fn: () => Promise<void>) => void;
}): Promise<MountHarness> => {
  const admission = options.admission ?? new ResourceAdmission(options.admissionLimit ?? 8);
  const sessionAdmission =
    options.sessionAdmission ?? new ResourceAdmission(options.sessionLimit ?? 8);
  const calls = options.calls ?? new BackendCalls(options.callLimit ?? 16);
  const logs = options.logs ?? new LogBuffer();
  const diagnostics: string[] = [];
  const mount = createMount(
    options.name ?? 'test-server',
    options.server,
    (summary) => diagnostics.push(summary),
    admission,
    calls,
    sessionAdmission,
    logs,
  );
  const inFlight = new Set<Promise<void>>();
  const httpServer = createServer((req, res) => {
    const task = (async () => {
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      if (req.method === 'POST') {
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.toLowerCase().includes('application/json')) {
          await readRequestBody(req, MAX_BACKEND_MESSAGE_BYTES, controller.signal);
        } else {
          const text = await readBodyText(req);
          if (text.length > 0) {
            try {
              (req as GatewayRequest).body = JSON.parse(text);
            } catch {
              (req as GatewayRequest).body = text;
            }
          }
        }
      }
      await mount.handle(req, res);
    })().catch(() => {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 400;
        res.end();
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  });

  const port = await listen(httpServer);
  const url = `http://127.0.0.1:${port}/mcp`;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await closeMount(mount);
    } finally {
      await Promise.allSettled([...inFlight]);
      await closeServer(httpServer);
    }
  };
  (options.trackCleanup ?? defaultTrackCleanup)(close);

  return {
    url,
    mount,
    admission,
    sessionAdmission,
    calls,
    logs,
    diagnostics,
    post: (body, headers = {}) =>
      fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    request: (method, reqOptions = {}) =>
      fetch(url, {
        method,
        signal: reqOptions.signal ?? AbortSignal.timeout(10_000),
        headers: reqOptions.headers,
        body: reqOptions.body,
      }),
    waitForIdle: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    close,
  };
};
