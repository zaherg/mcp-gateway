import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MODERN_VERSION } from 'supergateway/dist/lib/upstreamModernChild.js';

import { isHttpServer } from '@mcp-gateway/core/config';
import { failure, type GatewayError } from '@mcp-gateway/core/errors';
import { boundedBackendResponse } from '@mcp-gateway/core/limits';
import type {
  HttpServerConfig,
  ServerCheckResult,
  StdioServerConfig,
} from '@mcp-gateway/shared/types';

// Matches the gateway's own request deadline.
const CHECK_MS = 30_000;
const CLEANUP_MS = 2_000;
// Supergateway answers with this when the backend exited or never started.
const PROCESS_FAILED = -32603;
// A backend without 2026-07-28 support answers server/discover with this.
const METHOD_NOT_FOUND = -32601;
// The gateway answers these itself, with an empty body.
const REFUSALS = new Set([401, 403, 404, 405, 413, 415, 429, 503]);

interface EndpointCheck {
  /** The live listener address plus /mcp/<name>. */
  url: URL;
  /** The endpoint's effective inbound key. */
  token: string;
  /** The saved, expanded entry the endpoint was mounted from. */
  server: StdioServerConfig | HttpServerConfig;
  /** Aborted by Stop, quit or removal of this endpoint. */
  stopped: AbortSignal;
}

/** What the handshake's first POST revealed; the SDK reports several causes with one error. */
interface HandshakeReply {
  status: number | undefined;
  code: number | undefined;
}

const jsonRpcErrorCode = (text: string): number | undefined => {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'number' ? code : undefined;
  } catch {
    // The SDK reports malformed JSON itself.
    return undefined;
  }
};

const commandAdvice = (server: StdioServerConfig): string =>
  // The launcher looks the command up in the server's PATH, else the app's own.
  Bun.which(server.command, { PATH: server.env?.PATH ?? process.env.PATH, cwd: server.cwd }) ===
  null
    ? 'The gateway could not find the program in Command. Enter its full path (run command -v <name> in Terminal), save, and test again.'
    : "The server stopped before it answered. If Command starts another program, add that program's folder to PATH in Environment, save, and test again. See Logs.";

/** Fixed advice for a failed handshake, checked in order of precedence. */
const explainFailure = (
  error: unknown,
  server: StdioServerConfig | HttpServerConfig,
  reply: HandshakeReply,
  { cancelled, timedOut }: { cancelled: boolean; timedOut: boolean },
): GatewayError => {
  if (cancelled)
    return failure('Cancelled', 'The test stopped because the gateway or this server changed.');
  if (timedOut || reply.status === 504)
    return failure('BackendFailure', 'The server did not answer within 30 seconds. See Logs.');
  // Session handshakes throw the JSON-RPC error itself; discover failures do not.
  const thrown = (error as { code?: unknown } | null)?.code;
  const code = typeof thrown === 'number' ? thrown : reply.code;
  if (code === undefined && reply.status !== undefined && REFUSALS.has(reply.status))
    return failure(
      'ListenerFailure',
      reply.status === 403
        ? 'The gateway refused this Mac (HTTP 403). Check Allowed client ranges.'
        : `The gateway refused the test (HTTP ${reply.status}).`,
    );
  if (code === METHOD_NOT_FOUND && !server.legacyProtocol)
    return failure(
      'BackendFailure',
      'The server does not support MCP 2026-07-28. Turn on Allow session-based clients, save, and test again.',
    );
  if (code === PROCESS_FAILED)
    return failure(
      'BackendFailure',
      isHttpServer(server)
        ? 'The upstream server did not answer. Check Upstream URL and Headers. See Logs.'
        : commandAdvice(server),
    );
  return failure('BackendFailure', 'The server did not complete the MCP handshake. See Logs.');
};

/** Sends the handshake a client would send, through the gateway's own route and policy. */
export const checkEndpoint = async ({
  url,
  token,
  server,
  stopped,
}: EndpointCheck): Promise<ServerCheckResult> => {
  const deadline = AbortSignal.timeout(CHECK_MS);
  const lifetime = AbortSignal.any([stopped, deadline]);
  const reply: HandshakeReply = { status: undefined, code: undefined };
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      // The key goes to this endpoint only: no other URL, proxy or redirect.
      if (String(input) !== url.href) throw new Error('Unexpected check destination.');
      const limit =
        init?.method === 'DELETE'
          ? AbortSignal.any([stopped, AbortSignal.timeout(CLEANUP_MS)])
          : lifetime;
      const response = boundedBackendResponse(
        await fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit,
          proxy: false,
          redirect: 'error',
        }),
      );
      // Only the first POST, the handshake, explains a failure.
      if (init?.method !== 'POST' || reply.status !== undefined) return response;
      reply.status = response.status;
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        return response;
      // In 2026-07-28 mode the SDK reports every rejected discover the same way, so keep
      // the JSON-RPC code here. The body is read once and handed on unchanged.
      const text = await response.text();
      reply.code = jsonRpcErrorCode(text);
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  const client = new Client(
    { name: 'mcp-gateway-check', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation: {
        mode: server.legacyProtocol ? 'legacy' : { pin: MODERN_VERSION },
        probe: { timeoutMs: CHECK_MS, maxRetries: 0 },
      },
    },
  );
  let passed = false;
  try {
    await client.connect(transport, { timeout: CHECK_MS, signal: lifetime });
    const protocolVersion = client.getNegotiatedProtocolVersion();
    if (!protocolVersion) throw new Error('No protocol version was negotiated.');
    passed = true;
    return { protocolVersion };
  } catch (error) {
    throw explainFailure(error, server, reply, {
      cancelled: stopped.aborted,
      timedOut: deadline.aborted,
    });
  } finally {
    // A failed handshake has already closed the transport. shortcut: a session whose
    // DELETE fails ends after the gateway's 60-second idle timeout instead.
    if (passed && transport.sessionId) await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
};
