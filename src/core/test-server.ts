import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { MODERN_VERSION } from '@mcp-gateway/core/adapter';
import { isDisallowedUpstreamUrl, isHttpServer } from '@mcp-gateway/core/config';
import { failure } from '@mcp-gateway/core/errors';
import { boundedBackendResponse } from '@mcp-gateway/core/limits';
import type { HttpServerConfig, LogLevel, StdioServerConfig } from '@mcp-gateway/shared/types';

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
  /** Optional sink for test diagnostics recorded in Logs. */
  onDiagnostic?: (level: LogLevel, values: readonly unknown[]) => void;
}

/** What the handshake's first POST revealed; the SDK reports several causes with one error. */
interface HandshakeReply {
  status: number | undefined;
  contentType: string | undefined;
  code: number | undefined;
  message: string | undefined;
}

const jsonRpcError = (text: string): { code?: number; message?: string } => {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } } | null)
      ?.error;
    return {
      code: typeof error?.code === 'number' ? error.code : undefined,
      message: typeof error?.message === 'string' ? error.message : undefined,
    };
  } catch {
    // The SDK reports malformed JSON itself.
    return {};
  }
};

const errorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause && !error.message.includes(cause) ? `${error.message} (${cause})` : error.message;
};

const diagnosticSummary = (error: unknown, reply: HandshakeReply, timedOut: boolean) => {
  const details: string[] = [];
  if (timedOut) details.push('timed out after 30s');
  if (reply.status !== undefined) {
    details.push(
      reply.contentType && reply.contentType !== 'application/json'
        ? `HTTP ${reply.status}, ${reply.contentType}`
        : `HTTP ${reply.status}`,
    );
  }
  const thrown = (error as { code?: unknown } | null)?.code;
  const code = typeof thrown === 'number' ? thrown : reply.code;
  if (code !== undefined) {
    details.push(reply.message ? `JSON-RPC ${code}: ${reply.message}` : `JSON-RPC ${code}`);
  } else if (reply.message) {
    details.push(reply.message);
  }
  const prefix = details.length
    ? `Server test failed (${details.join(', ')}):`
    : 'Server test failed:';
  return [prefix, errorDetail(error)] as const;
};

const commandAdvice = (server: StdioServerConfig) =>
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
) => {
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
  onDiagnostic,
}: EndpointCheck) => {
  if (isDisallowedUpstreamUrl(url))
    throw failure(
      'NetworkPolicy',
      'Link-local and cloud metadata upstream addresses are not allowed.',
    );
  if (isHttpServer(server)) {
    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(server.url);
    } catch {
      throw failure('InvalidConfig', 'An upstream URL is invalid.');
    }
    if (isDisallowedUpstreamUrl(upstreamUrl))
      throw failure(
        'NetworkPolicy',
        'Link-local and cloud metadata upstream addresses are not allowed.',
      );
  }
  const deadline = AbortSignal.timeout(CHECK_MS);
  const lifetime = AbortSignal.any([stopped, deadline]);
  const reply: HandshakeReply = {
    status: undefined,
    contentType: undefined,
    code: undefined,
    message: undefined,
  };
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
      reply.contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
      if (reply.contentType !== 'application/json') return response;
      // In 2026-07-28 mode the SDK reports every rejected discover the same way, so keep
      // the JSON-RPC code here. The body is read once and handed on unchanged.
      const text = await response.text();
      const rpcError = jsonRpcError(text);
      reply.code = rpcError.code;
      reply.message = rpcError.message;
      return new Response(text, {
        status: response.status,
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
    if (!stopped.aborted) {
      onDiagnostic?.('error', diagnosticSummary(error, reply, deadline.aborted));
    }
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
