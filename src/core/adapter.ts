import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants } from 'node:os';

import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type JSONRPCNotification,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { createParser } from 'eventsource-parser';

import { isHttpServer } from '@mcp-gateway/core/config';
import { failure } from '@mcp-gateway/core/errors';
import {
  BACKEND_CAPACITY_ERROR,
  type BackendCalls,
  BackendOutputLimitError,
  boundedBackendResponse,
  type JsonRpcErrorBody,
  MAX_SSE_EVENT_BYTES,
  type ResourceAdmission,
  type ResourceLease,
  readBackendLines,
  releaseAfterCleanup,
  writeJsonRpcError,
} from '@mcp-gateway/core/limits';
import { LogBuffer } from '@mcp-gateway/core/logs';
import { BackendProcesses, childEnvironment } from '@mcp-gateway/core/process';
import {
  createSessions,
  type GatewayLogger,
  type GatewayRequest,
  type GatewayResponse,
  type Source,
  type Upstream,
} from '@mcp-gateway/core/sessions';
import { isRecord } from '@mcp-gateway/shared/config-document';
import type { HttpServerConfig, LogLevel, StdioServerConfig } from '@mcp-gateway/shared/types';

export interface GatewayMount {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

interface DeclaredSession {
  version: string | undefined;
  params: Record<string, string>;
}

const SHUTDOWN_MS = 8_000;
export const MODERN_VERSION = '2026-07-28';
const SPEAKS_FOR_MS = 60_000;
const CONTINUATION_TIMEOUT = 300_000;
const RETAINED_CHILD_LIMIT = 64;
const FINISH_GRACE_MS = 5_000;
const HEADER_MISMATCH = -32020;
const SERVER_ERROR = -32000;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const FRAMING_ERRORS = [HEADER_MISMATCH, -32021, -32022];
const PROCESS_FAILED: JsonRpcErrorBody = {
  code: INTERNAL_ERROR,
  message: 'MCP server process failed',
};

/** Session-based (pre-2026-07-28) MCP is served only by endpoints that opt in. */
const UNSUPPORTED_PROTOCOL_ERROR: JsonRpcErrorBody = {
  code: -32600,
  message: 'Only MCP protocol version 2026-07-28 is supported.',
};

const ENCODED_PREFIX = '=?base64?';
const ENCODED_SUFFIX = '?=';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isEncoded = (value: string): boolean =>
  value.startsWith(ENCODED_PREFIX) && value.endsWith(ENCODED_SUFFIX);

const decodedHeader = (value: string | undefined): string | undefined => {
  if (value === undefined || !isEncoded(value)) return value;
  const payload = value.slice(ENCODED_PREFIX.length, -ENCODED_SUFFIX.length);
  if (!BASE64.test(payload)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payload, 'base64'));
  } catch {
    return undefined;
  }
};

const encodedHeader = (value: string): string =>
  /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !isEncoded(value)
    ? value
    : `${ENCODED_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${ENCODED_SUFFIX}`;

class HeaderMismatch extends Error {
  readonly code = HEADER_MISMATCH;
  constructor(readonly header: string) {
    super(`Request header ${header} does not match the request body`);
  }
}

type HeaderValue = (name: string) => string | undefined;

const headerValue =
  (req: IncomingMessage): HeaderValue =>
  (name) => {
    const header = req.headers[name];
    return Array.isArray(header) ? header.join(', ') : header;
  };

const paramHeaders = (req: IncomingMessage): Record<string, string> => {
  const value = headerValue(req);
  const headers: Record<string, string> = {};
  for (const name of Object.keys(req.headers)) {
    if (name.startsWith('mcp-param-')) {
      const header = value(name);
      if (header !== undefined) headers[name] = header;
    }
  }
  return headers;
};

const requestIdOf = (body: unknown): string | number | null => {
  if (!isRecord(body)) return null;
  const id = body.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
};

const rejectWith = (
  req: GatewayRequest,
  res: ServerResponse,
  status: number,
  error: JsonRpcErrorBody,
): void => {
  writeJsonRpcError(res, status, error, requestIdOf(req.body));
};

const NAME_FIELDS = new Map<string, string>([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri'],
]);

const mirroredHeaders = (message: JSONRPCMessage): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (!('method' in message)) return headers;
  headers['mcp-method'] = encodedHeader(message.method);
  const field = NAME_FIELDS.get(message.method);
  const params = isRecord(message.params) ? message.params : undefined;
  const name = field && params ? params[field] : undefined;
  if (typeof name === 'string') headers['mcp-name'] = encodedHeader(name);
  return headers;
};

const validateModernHeaders = (message: JSONRPCMessage, header: HeaderValue): void => {
  if (!('id' in message) || !('method' in message)) return;
  const params = isRecord(message.params) ? message.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const mirrored: Array<[string, unknown]> = [
    ['mcp-protocol-version', meta?.['io.modelcontextprotocol/protocolVersion']],
    ['mcp-method', message.method],
  ];
  const nameField = NAME_FIELDS.get(message.method);
  if (nameField) mirrored.push(['mcp-name', params?.[nameField]]);
  for (const [key, expected] of mirrored) {
    if (typeof expected === 'string' && decodedHeader(header(key)) !== expected)
      throw new HeaderMismatch(key);
  }
};

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const mirrors = (
  field: Record<string, unknown>,
  value: unknown,
  received: string | undefined,
): boolean =>
  field.type === 'integer' &&
  typeof value === 'number' &&
  received !== undefined &&
  /^-?\d+(\.\d+)?$/.test(received)
    ? Number(received) === value
    : received === String(value);

const checkMirroredHeader = (
  field: Record<string, unknown>,
  value: unknown,
  header: HeaderValue,
): void => {
  const name = field['x-mcp-header'];
  if (typeof name !== 'string' || value === undefined || value === null) return;
  const headerName = `mcp-param-${name.toLowerCase()}`;
  if (!mirrors(field, value, decodedHeader(header(headerName))))
    throw new HeaderMismatch(headerName);
};

const validateToolHeaders = (schema: unknown, args: unknown, header: HeaderValue): void => {
  const values = asRecord(args);
  const properties = asRecord(asRecord(schema).properties);
  for (const [key, property] of Object.entries(properties)) {
    const field = asRecord(property);
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    checkMirroredHeader(field, value, header);
    validateToolHeaders(field, value, header);
  }
};

const findToolSchema = async (
  name: string,
  page: (cursor?: string) => Promise<Record<string, unknown>>,
): Promise<unknown> => {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const result = await page(cursor);
    if (!Array.isArray(result.tools)) throw new Error('Invalid tools/list response');
    const tool = result.tools.find((item) => asRecord(item).name === name);
    if (tool) return asRecord(tool).inputSchema;
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('Repeated tools/list cursor');
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return undefined;
};

interface ModernClassification {
  readonly era: 'modern' | 'legacy';
  readonly revision: string | undefined;
}

type ModernRoute =
  | {
      readonly kind: 'modern';
      readonly messageKind: 'request';
      readonly message: JSONRPCRequest;
      readonly classification: ModernClassification;
    }
  | {
      readonly kind: 'modern';
      readonly messageKind: 'notification';
      readonly message: JSONRPCNotification;
      readonly classification: ModernClassification;
    };

type InboundRoute =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'reject';
      readonly httpStatus: number;
      readonly code: number;
      readonly message: string;
    }
  | ModernRoute;

const stripOws = (value: string): string => value.replace(/^[\t ]+|[\t ]+$/g, '');

const classifyInbound = (req: GatewayRequest, value: HeaderValue): InboundRoute => {
  if ((req.method ?? '').toUpperCase() !== 'POST') return { kind: 'legacy' };
  const body = req.body;
  if (Array.isArray(body) || isJSONRPCResultResponse(body) || isJSONRPCErrorResponse(body))
    return { kind: 'legacy' };
  const rawVersion = value('mcp-protocol-version');
  const headerVersion = rawVersion !== undefined ? stripOws(rawVersion) : undefined;
  const rawMethod = value('mcp-method');
  const headerMethod = rawMethod !== undefined ? stripOws(rawMethod) : undefined;

  if (isJSONRPCRequest(body)) {
    const params = isRecord(body.params) ? body.params : undefined;
    const meta = params && isRecord(params._meta) ? params._meta : undefined;
    const hasClaim =
      meta !== undefined && Object.hasOwn(meta, 'io.modelcontextprotocol/protocolVersion');
    if (hasClaim && meta) {
      const claimed = meta['io.modelcontextprotocol/protocolVersion'];
      if (typeof claimed !== 'string' || !claimed.length) {
        return {
          kind: 'reject',
          httpStatus: 400,
          code: -32602,
          message:
            'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/protocolVersion: expected a protocol version string',
        };
      }
      if (headerVersion !== undefined && decodedHeader(headerVersion) !== claimed) {
        return {
          kind: 'reject',
          httpStatus: 400,
          code: HEADER_MISMATCH,
          message: `Request header mcp-protocol-version does not match the request body`,
        };
      }
      if (claimed === MODERN_VERSION) {
        const clientInfo = meta['io.modelcontextprotocol/clientInfo'];
        const clientCaps = meta['io.modelcontextprotocol/clientCapabilities'];
        if (
          !isRecord(clientInfo) ||
          typeof clientInfo.name !== 'string' ||
          typeof clientInfo.version !== 'string' ||
          !isRecord(clientCaps)
        ) {
          return {
            kind: 'reject',
            httpStatus: 400,
            code: -32602,
            message: 'Invalid _meta envelope for protocol revision 2026-07-28',
          };
        }
      }
      return {
        kind: 'modern',
        messageKind: 'request',
        message: body,
        classification: { era: claimed >= MODERN_VERSION ? 'modern' : 'legacy', revision: claimed },
      };
    }
    if (headerVersion !== undefined && headerVersion >= MODERN_VERSION) {
      return {
        kind: 'reject',
        httpStatus: 400,
        code: -32602,
        message: 'Modern request requires _meta envelope',
      };
    }
    return { kind: 'legacy' };
  }

  if (isJSONRPCNotification(body)) {
    const params = isRecord(body.params) ? body.params : undefined;
    const meta = params && isRecord(params._meta) ? params._meta : undefined;
    const hasClaim =
      meta !== undefined && Object.hasOwn(meta, 'io.modelcontextprotocol/protocolVersion');
    if (hasClaim && meta) {
      const claimed = meta['io.modelcontextprotocol/protocolVersion'];
      if (typeof claimed !== 'string' || !claimed.length) {
        return {
          kind: 'reject',
          httpStatus: 400,
          code: -32602,
          message:
            'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/protocolVersion: expected a protocol version string',
        };
      }
      if (headerVersion !== undefined && decodedHeader(headerVersion) !== claimed) {
        return {
          kind: 'reject',
          httpStatus: 400,
          code: HEADER_MISMATCH,
          message: 'Request header mcp-protocol-version does not match the request body',
        };
      }
      if (
        claimed >= MODERN_VERSION &&
        headerMethod !== undefined &&
        decodedHeader(headerMethod) !== body.method
      ) {
        return {
          kind: 'reject',
          httpStatus: 400,
          code: HEADER_MISMATCH,
          message: 'Request header mcp-method does not match the request body',
        };
      }
      return {
        kind: 'modern',
        messageKind: 'notification',
        message: body,
        classification: { era: claimed >= MODERN_VERSION ? 'modern' : 'legacy', revision: claimed },
      };
    }
    if (headerVersion !== undefined && headerVersion >= MODERN_VERSION) {
      if (headerMethod !== undefined && decodedHeader(headerMethod) !== body.method) {
        return {
          kind: 'reject',
          httpStatus: 400,
          code: HEADER_MISMATCH,
          message: 'Request header mcp-method does not match the request body',
        };
      }
      return {
        kind: 'modern',
        messageKind: 'notification',
        message: body,
        classification: { era: 'modern', revision: headerVersion },
      };
    }
    return { kind: 'legacy' };
  }

  return {
    kind: 'reject',
    httpStatus: 400,
    code: -32600,
    message: 'Bad Request: the request body is not a valid JSON-RPC message',
  };
};

const acceptsBoth = (accept: string): boolean =>
  accept.includes('application/json') && accept.includes('text/event-stream');

const admit = async (
  req: GatewayRequest,
  res: ServerResponse,
  value: HeaderValue,
  speaks: () => boolean | Promise<boolean>,
): Promise<boolean | ModernRoute> => {
  const reject = (status: number, error: JsonRpcErrorBody): true => {
    rejectWith(req, res, status, error);
    return true;
  };
  const route = classifyInbound(req, value);
  if (route.kind === 'legacy') return false;
  if (!(await speaks())) return false;
  const contentType = value('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return reject(415, {
      code: SERVER_ERROR,
      message: 'Content-Type must be application/json',
    });
  }
  if (route.kind === 'reject') {
    return reject(route.httpStatus, {
      code: route.code,
      message: route.message,
    });
  }
  if (!acceptsBoth(value('accept') ?? '')) {
    return reject(406, {
      code: SERVER_ERROR,
      message: 'Client must accept application/json and text/event-stream',
    });
  }
  try {
    validateModernHeaders(route.message, value);
  } catch (error) {
    return reject(400, {
      code: HEADER_MISMATCH,
      message: error instanceof Error ? error.message : 'Header mismatch',
    });
  }
  return route;
};

interface ModernChild {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  cleanedUp?: boolean;
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  hold(drained: Promise<void> | undefined): void;
  finish(): Promise<void>;
  close(): Promise<void>;
}

interface ReusedChild {
  child: ModernChild;
  state: unknown;
}

const isContinuationHandle = (state: unknown): state is string =>
  typeof state === 'string' && state.startsWith('sgw:');

const detachChild = (child: ModernChild): void => {
  child.onmessage = undefined;
  child.onerror = undefined;
  child.onclose = undefined;
};

interface RetainedFlow {
  child: ModernChild;
  handles: Set<string>;
  waiters: Set<() => void>;
  busy: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

class RetainedChildren {
  private readonly entries = new Map<string, { flow: RetainedFlow; state: unknown }>();
  private readonly flows = new WeakMap<ModernChild, RetainedFlow>();
  private readonly closing = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: { idleMs: number; limit: number; logger: GatewayLogger }) {}

  retain(state: unknown, child: ModernChild): string {
    let flow = this.flows.get(child);
    if (!flow) {
      flow = { child, handles: new Set(), waiters: new Set(), busy: true };
      this.flows.set(child, flow);
    }
    const handle = `sgw:${randomUUID()}`;
    flow.handles.add(handle);
    this.entries.set(handle, { flow, state });
    while (this.entries.size > this.options.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const previous = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (previous) {
        previous.flow.handles.delete(oldest);
        this.wake(previous.flow);
        if (!previous.flow.busy && previous.flow.handles.size === 0)
          void this.discard(previous.flow.child);
      }
    }
    return handle;
  }

  async take(handle: string, signal?: AbortSignal): Promise<ReusedChild | undefined> {
    for (;;) {
      const binding = this.entries.get(handle);
      if (!binding || this.closed || signal?.aborted) return undefined;
      const flow = binding.flow;
      if (!flow.busy) {
        flow.busy = true;
        clearTimeout(flow.timer);
        detachChild(flow.child);
        this.entries.delete(handle);
        this.entries.set(handle, binding);
        return { child: flow.child, state: binding.state };
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          flow.waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        flow.waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  async release(child: ModernChild): Promise<void> {
    const flow = this.flows.get(child);
    if (this.closed || !flow || flow.handles.size === 0) {
      await this.discard(child);
      return;
    }
    flow.busy = false;
    clearTimeout(flow.timer);
    child.onmessage = () => {};
    child.onerror = () => {
      void this.discard(child);
    };
    child.onclose = () => {
      void this.discard(child);
    };
    flow.timer = setTimeout(() => void this.discard(child), this.options.idleMs);
    this.wake(flow);
  }

  async discard(child: ModernChild): Promise<void> {
    const flow = this.flows.get(child);
    if (flow) {
      clearTimeout(flow.timer);
      for (const handle of flow.handles) this.entries.delete(handle);
      flow.handles.clear();
      this.flows.delete(child);
      this.wake(flow);
    }
    detachChild(child);
    const closing = child.close().catch((error) => {
      this.options.logger.error('Failed to close retained MCP child:', error);
    });
    this.closing.add(closing);
    try {
      await closing;
    } finally {
      this.closing.delete(closing);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const children = new Set([...this.entries.values()].map((binding) => binding.flow.child));
    await Promise.all([...children].map((child) => this.discard(child)));
    await Promise.all(this.closing);
  }

  private wake(flow: RetainedFlow): void {
    for (const done of flow.waiters) done();
  }
}

const untilDrained = (res: ServerResponse): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });

const drained = (responses: readonly ServerResponse[]): Promise<void> | undefined => {
  const full = responses.filter((res) => res.writableNeedDrain);
  if (full.length) return Promise.all(full.map(untilDrained)).then(() => {});
  return undefined;
};

/**
 * Normalizes SSE line endings across chunks.
 * A terminal CR is normalised immediately: the pinned parser otherwise defers it.
 */
const createLineFeed = (push: (text: string) => void): ((text: string) => void) => {
  let afterCR = false;
  return (text) => {
    if (!text) return;
    const normalized = afterCR && text.startsWith('\n') ? text.slice(1) : text;
    afterCR = text.endsWith('\r');
    push(normalized.replace(/\r\n?/g, '\n'));
  };
};

class CapacityError extends Error {}

// These are logged at error level, but the client caused them: its own HTTP
// transport failed, or its headers did not mirror the body.
// They stay in Logs and never mark the backend as failed, as in sessions.ts.
const CLIENT_TRANSPORT_ERRORS = new Set([
  'Modern HTTP transport error:',
  'Modern HTTP adapter error:',
  'Failed to send MCP error:',
]);
const clientCaused = (args: readonly unknown[]): boolean =>
  (typeof args[0] === 'string' && CLIENT_TRANSPORT_ERRORS.has(args[0])) ||
  args.some((value) => value instanceof HeaderMismatch);

// Only the owned close promise proves that backend work ended.
const cleanupConfirmed = (child: ModernChild): boolean => child.cleanedUp === true;

class ChildQuery {
  private pending:
    | {
        id: string;
        resolve: (message: JSONRPCMessage) => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  get waiting(): boolean {
    return this.pending !== undefined;
  }

  ask(
    child: ModernChild,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JSONRPCMessage> {
    const id = randomUUID();
    let rejectReply: ((error: unknown) => void) | undefined;
    const reply = new Promise<JSONRPCMessage>((resolve, reject) => {
      rejectReply = reject;
      this.pending = { id, resolve, reject };
    });
    void child.send({ jsonrpc: '2.0', id, method, params }).catch((error) => rejectReply?.(error));
    return reply;
  }

  receive(message: JSONRPCMessage): void {
    if (this.pending && 'id' in message && message.id === this.pending.id) {
      const resolve = this.pending.resolve;
      this.pending = undefined;
      resolve(message);
    }
  }
}

const restoredState = <T extends JSONRPCMessage>(message: T, reused?: ReusedChild): T => {
  if (!reused || !('params' in message) || !isRecord(message.params)) return message;
  const params: Record<string, unknown> = { ...message.params };
  delete params.requestState;
  if (reused.state !== undefined) params.requestState = reused.state;
  return { ...message, params };
};

const withoutProgressToken = (callMeta: unknown): Record<string, unknown> => {
  const meta = { ...asRecord(callMeta) };
  delete meta.progressToken;
  return meta;
};

const statusForError = (code: number): number =>
  code === METHOD_NOT_FOUND ? 404 : FRAMING_ERRORS.includes(code) ? 400 : 200;

const mintedState = (result: unknown): { value: string | undefined } | undefined => {
  if (!isRecord(result)) return undefined;
  const { resultType, requestState } = result;
  return resultType === 'input_required' &&
    (requestState === undefined || typeof requestState === 'string')
    ? { value: requestState }
    : undefined;
};

class WorkTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private started = false;
  private used = false;
  private closed = false;
  private terminalDelivered = false;
  private requestId: string | number | undefined;
  private deferred:
    | {
        promise: Promise<Response>;
        resolve: (res: Response) => void;
        reject: (err: Error) => void;
        settled: boolean;
      }
    | undefined;
  private sse:
    | {
        controller: ReadableStreamDefaultController<Uint8Array>;
        encoder: TextEncoder;
        closed: boolean;
      }
    | undefined;

  constructor(private readonly replied: (message: JSONRPCMessage) => void) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('WorkTransport is already started');
    this.started = true;
  }

  async handleMessage(message: JSONRPCMessage): Promise<Response> {
    if (this.used) throw new Error('WorkTransport serves one exchange');
    if (!this.started || !this.onmessage) throw new Error('WorkTransport is not connected');
    if (this.closed) throw new Error('WorkTransport is closed');
    this.used = true;
    if (isJSONRPCRequest(message)) {
      this.requestId = message.id;
      let resolve!: (res: Response) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.deferred = { promise, resolve, reject, settled: false };
      this.onmessage(message);
      return promise;
    }
    this.onmessage(message);
    return new Response(null, { status: 202 });
  }

  async send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: string | number },
  ): Promise<void> {
    if (!('method' in message) && 'id' in message) this.replied(message);
    if (this.closed) return;
    const isResponse = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
    const relatedId = isResponse ? message.id : options?.relatedRequestId;
    if (this.requestId === undefined || relatedId === undefined || relatedId !== this.requestId) {
      if (isResponse)
        this.onerror?.(
          new Error(`Received a response for an unknown request id: ${String(message.id)}`),
        );
      return;
    }
    if (isResponse) {
      if (this.terminalDelivered) return;
      this.terminalDelivered = true;
      if (this.sse !== undefined) {
        this.writeMessageFrame(message);
        this.finalizeStream();
        return;
      }
      this.settleResponse(
        Response.json(message, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      queueMicrotask(() => void this.close());
      return;
    }
    if (this.sse === undefined) this.upgradeToSse();
    this.writeMessageFrame(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sse !== undefined && !this.sse.closed) {
      this.sse.closed = true;
      try {
        this.sse.controller.close();
      } catch {}
    }
    if (this.deferred !== undefined && !this.deferred.settled) {
      this.deferred.settled = true;
      this.deferred.reject(new Error('Connection closed before a response was produced'));
    }
    this.onclose?.();
  }

  private settleResponse(response: Response): void {
    if (this.deferred === undefined || this.deferred.settled) return;
    this.deferred.settled = true;
    this.deferred.resolve(response);
  }

  private upgradeToSse(): void {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
      cancel: () => {
        void this.close();
      },
    });
    this.sse = { controller, encoder: new TextEncoder(), closed: false };
    this.settleResponse(
      new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      }),
    );
  }

  private finalizeStream(): void {
    if (this.sse !== undefined && !this.sse.closed) {
      this.sse.closed = true;
      try {
        this.sse.controller.close();
      } catch {}
    }
    queueMicrotask(() => void this.close());
  }

  private writeMessageFrame(message: JSONRPCMessage): void {
    if (this.sse === undefined || this.sse.closed) return;
    try {
      this.sse.controller.enqueue(
        this.sse.encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
      );
    } catch (error) {
      this.onerror?.(new Error(`Failed to write to the response stream: ${String(error)}`));
    }
  }
}

class ModernRequest {
  private awaitingReply = false;
  private readonly message: JSONRPCMessage;
  private readonly query = new ChildQuery();
  private responseStatus = 200;
  private dispatched: Promise<void> | undefined;
  private failed = false;
  private stopPromise: Promise<void> | undefined;
  private readonly closed = () => {
    void this.stop();
  };

  constructor(
    private readonly at: {
      req: GatewayRequest;
      res: ServerResponse;
      route: ModernRoute;
      value: HeaderValue;
      transport: WorkTransport;
      reused?: ReusedChild;
      child: ModernChild;
      retained: RetainedChildren;
      active: Set<() => Promise<void>>;
      children: BackendProcesses;
      logger: GatewayLogger;
    },
  ) {
    const { route, reused, child, transport, logger } = at;
    this.message = restoredState(route.message, reused);
    child.onerror = (error) => {
      void this.fail(error);
    };
    child.onclose = () => {
      void this.fail(new Error('Child stdout closed'));
    };
    child.onmessage = (message) => this.fromChild(message);
    transport.onerror = (error) => logger.error('Modern HTTP transport error:', error);
    transport.onclose = () => {
      void this.stop();
    };
    transport.onmessage = () => {
      this.dispatched = this.dispatch().catch(this.fail);
    };
  }

  private get stopped(): boolean {
    return this.stopPromise !== undefined;
  }

  readonly stop = (): Promise<void> => {
    const { res, logger } = this.at;
    if (!this.stopPromise) {
      res.off('close', this.closed);
      this.stopPromise = Promise.resolve()
        .then(() => this.cleanUp())
        .catch((error) => {
          logger.error('Modern request cleanup failed:', error);
        });
    }
    return this.stopPromise;
  };

  private async cleanUp(): Promise<void> {
    const { transport, active, retained, child } = this.at;
    try {
      await transport.close();
    } finally {
      try {
        await (!this.failed && !this.awaitingReply
          ? retained.release(child)
          : retained.discard(child));
      } finally {
        active.delete(this.stop);
      }
    }
  }

  private readonly fail = async (error: unknown): Promise<void> => {
    const { route, transport, logger } = this.at;
    if (this.stopped || this.failed) return;
    this.failed = true;
    logger.error('MCP child request failed:', error);
    const mismatch = error instanceof HeaderMismatch;
    if (mismatch) this.responseStatus = 400;
    if (route.messageKind === 'request') {
      await transport
        .send({
          jsonrpc: '2.0',
          id: route.message.id,
          error: mismatch ? { code: error.code, message: error.message } : PROCESS_FAILED,
        })
        .catch((sendError) => logger.error('Failed to send MCP error:', sendError));
    }
    await this.stop();
  };

  private repliesToRequest(message: JSONRPCMessage): boolean {
    const { route } = this.at;
    return 'id' in message && route.messageKind === 'request' && message.id === route.message.id;
  }

  private fromChild(message: JSONRPCMessage): void {
    const { route, transport, child, res, retained } = this.at;
    if (this.stopped) return;
    if ('method' in message && 'id' in message) {
      void this.fail(new Error('Unexpected server request on a modern connection'));
      return;
    }
    if (this.query.waiting) {
      this.query.receive(message);
      return;
    }
    let outbound = message;
    if (this.repliesToRequest(outbound)) {
      if ('error' in outbound) this.responseStatus = statusForError(outbound.error.code);
      this.awaitingReply = false;
      if ('result' in outbound) {
        const state = mintedState(outbound.result);
        if (state && isRecord(outbound.result)) {
          outbound = {
            ...outbound,
            result: {
              ...outbound.result,
              requestState: retained.retain(state.value, child),
            },
          };
        }
      }
    }
    void transport
      .send(outbound, {
        relatedRequestId: route.messageKind === 'request' ? route.message.id : undefined,
      })
      .catch(this.fail);
    child.hold(drained([res]));
  }

  private async listToolsPage(
    callMeta: unknown,
    cursor?: string,
  ): Promise<Record<string, unknown>> {
    if (this.stopped) throw new Error('Request closed');
    const result = await this.query.ask(this.at.child, 'tools/list', {
      _meta: withoutProgressToken(callMeta),
      ...(cursor === undefined ? {} : { cursor }),
    });
    if ('error' in result) throw new Error(`tools/list failed: ${result.error.message}`);
    if (!('result' in result) || !isRecord(result.result))
      throw new Error('Invalid tools/list response');
    return result.result;
  }

  private async dispatch(): Promise<void> {
    const { route, reused, child, children, value } = this.at;
    if (this.stopped || children.closing) throw new Error('Gateway is shutting down');
    if (!reused) {
      await child.start();
      if (this.stopped) {
        await child.close();
        return;
      }
    }
    const message = this.message;
    if (route.messageKind === 'request' && 'method' in message && message.method === 'tools/call') {
      const params = asRecord(message.params);
      const name = typeof params.name === 'string' ? params.name : '';
      const schema = await findToolSchema(name, (cursor) =>
        this.listToolsPage(params._meta, cursor),
      );
      validateToolHeaders(schema, params.arguments, value);
    }
    if (this.stopped) return;
    this.awaitingReply = route.messageKind === 'request';
    await child.send(message);
    if (route.messageKind === 'notification') await child.finish();
  }

  private async respond(): Promise<Response> {
    const { route, transport } = this.at;
    const response = await transport.handleMessage(route.message);
    if (route.messageKind === 'notification') {
      await this.dispatched;
      if (this.failed) {
        return Response.json(
          { jsonrpc: '2.0', id: null, error: PROCESS_FAILED },
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }
    if (
      response.headers.get('content-type')?.includes('application/json') &&
      this.responseStatus !== response.status
    ) {
      return new Response(response.body, {
        status: this.responseStatus,
        headers: response.headers,
      });
    }
    return response;
  }

  async serve(): Promise<boolean> {
    const { req, res, transport, active, logger } = this.at;
    active.add(this.stop);
    res.once('close', this.closed);
    if (res.destroyed) {
      await this.stop();
      return true;
    }
    await transport.start();
    try {
      await this.writeResponse(req, res, logger);
    } finally {
      await this.stop();
    }
    return true;
  }

  private async writeResponse(
    req: GatewayRequest,
    res: ServerResponse,
    logger: GatewayLogger,
  ): Promise<void> {
    let finished = false;
    const abort = new AbortController();
    res.on('close', () => {
      if (!finished) abort.abort();
    });
    if (res.destroyed) abort.abort();
    let response: Response;
    try {
      response = await this.respond();
    } catch (error) {
      logger.error('Modern HTTP adapter error:', error);
      response = Response.json(
        {
          jsonrpc: '2.0',
          id: requestIdOf(req.body),
          error: { code: -32603, message: 'Internal server error' },
        },
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers) headers[name] = value;
    res.writeHead(response.status, headers);
    if (response.body === null) {
      finished = true;
      res.end();
      return;
    }
    let drainResolve: (() => void) | undefined;
    const releaseDrainWait = () => {
      drainResolve?.();
      drainResolve = undefined;
    };
    res.on('drain', releaseDrainWait);
    const closed = new Promise<void>((resolve) => {
      abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    try {
      for await (const chunk of response.body) {
        if (abort.signal.aborted) break;
        if (res.write(chunk) === false) {
          await Promise.race([
            new Promise<void>((resolve) => {
              drainResolve = resolve;
            }),
            closed,
          ]);
        }
      }
    } catch {}
    finished = true;
    res.end();
  }
}

export const createMount = (
  name: string,
  server: StdioServerConfig | HttpServerConfig,
  onDiagnostic: (summary: string) => void,
  admission: ResourceAdmission,
  calls: BackendCalls,
  sessionAdmission: ResourceAdmission,
  logs = new LogBuffer(),
): GatewayMount => {
  let closing = false;
  const serverSecrets: string[] = [];
  if (server.token) serverSecrets.push(server.token);
  if (isHttpServer(server)) {
    if (server.headers) serverSecrets.push(...Object.values(server.headers));
  } else {
    if (server.env) serverSecrets.push(...Object.values(server.env));
  }
  if (serverSecrets.length > 0) logs.registerSecrets?.(serverSecrets);
  const logTraffic =
    'logTraffic' in server && Boolean((server as { logTraffic?: boolean }).logTraffic);

  const capture = (level: LogLevel, args: unknown[], diagnose = true) => {
    const stderr = typeof args[0] === 'string' && args[0].startsWith('Child stderr:');
    logs.append({ server: name, level, source: stderr ? 'stderr' : 'logger' }, args);
    // Upstream HTTP transports also report a synthetic null/null "child" exit
    // on close. Preserve that log without replacing the actual HTTP failure.
    const upstreamClosed =
      isHttpServer(server) && args[0] === 'Child exited: code=null, signal=null';
    if (
      diagnose &&
      !closing &&
      level === 'error' &&
      !stderr &&
      !upstreamClosed &&
      !clientCaused(args)
    )
      onDiagnostic(backendSummary(args));
  };
  const diagnostic = (...args: unknown[]) => capture('error', args);
  const logger: GatewayLogger = {
    info: (...args) => capture('info', args),
    error: diagnostic,
    debug: (...args) => capture('debug', args),
    warn: (...args) => capture('warn', args),
  };
  // Configuration parsing already validated this URL; refuse rather than throw if that ever changes.
  const upstreamUrl = isHttpServer(server) ? URL.parse(server.url) : null;
  if (isHttpServer(server) && !upstreamUrl)
    throw failure('BackendFailure', 'The backend mount could not be created.');
  const source: Source = isHttpServer(server)
    ? { upstream: { type: 'streamableHttp', url: upstreamUrl as URL, headers: server.headers } }
    : {
        stdioCmd: {
          command: server.command,
          args: server.args ?? [],
          env: server.env,
          cwd: server.cwd,
        },
      };
  const children = new BackendProcesses(logger);
  const reserve = () => {
    if (children.closing) throw failure('Closed', 'The backend is closing.');
    const lease = admission.acquire();
    if (!lease) throw new CapacityError();
    return lease;
  };

  class LeasedStdio implements ModernChild {
    onmessage?: (message: JSONRPCMessage) => void;
    onerror?: (error: Error) => void;
    onclose?: () => void;
    child?: ChildProcessWithoutNullStreams;
    stop?: () => Promise<void>;
    private closed = false;
    close: () => Promise<void>;
    cleanedUp = false;

    async start(): Promise<void> {
      if (!source.stdioCmd) throw new Error('Expected stdio source');
      const child = spawn(source.stdioCmd.command, source.stdioCmd.args, {
        ...children.spawnOptions,
        cwd: source.stdioCmd.cwd,
        env: childEnvironment(source.stdioCmd.env),
        stdio: 'pipe',
      });
      this.child = child;
      this.stop = children.own(child);
      this.watch(child);
      if (logTraffic) {
        child.stderr.on('data', (chunk) => logger.error('Child stderr:', chunk.toString('utf8')));
      } else {
        let stderrReported = false;
        child.stderr.on('data', () => {
          if (stderrReported) return;
          stderrReported = true;
          logger.error(
            'Child stderr: Child stderr output suppressed (enable traffic logging or inspect redacted diagnostics).',
          );
        });
      }
      readBackendLines(
        child.stdout,
        (line) => this.deliver(line),
        (error) => {
          child.stdout.destroy(error);
        },
        () => undefined,
      );
    }

    watch(child: ChildProcessWithoutNullStreams): void {
      const fail = (error: Error) => {
        if (this.closed) return;
        logger.error('MCP child failed:', error);
        this.onerror?.(error);
        void this.close();
      };
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stdout.on('end', () => fail(new Error('Child stdout closed')));
      child.on('exit', (code, signal) => {
        fail(new Error(`Child exited: code=${code}, signal=${signal}`));
      });
    }

    deliver(line: string): void {
      if (!line.trim()) return;
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(line));
      } catch {
        logger.error('Child non-JSON message:', line);
        return;
      }
      this.onmessage?.(message);
    }

    hold(drainedPromise: Promise<void> | undefined): void {
      const stdout = this.child?.stdout;
      if (!stdout || !drainedPromise || stdout.isPaused()) return;
      stdout.pause();
      void drainedPromise.then(() => stdout.resume());
    }

    async send(message: JSONRPCMessage): Promise<void> {
      const child = this.child;
      if (this.closed || !child) throw new Error('MCP child is closed');
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    async finish(): Promise<void> {
      const child = this.child;
      if (!child || this.closed || child.exitCode !== null || child.signalCode !== null) return;
      this.closed = true;
      await new Promise<void>((resolve, reject) => {
        const done = (code?: number | null) => {
          clearTimeout(timer);
          child.off('exit', done);
          if (typeof code === 'number' && code !== 0)
            reject(new Error(`Child exited: code=${code}`));
          else resolve();
        };
        const timer = setTimeout(() => done(), FINISH_GRACE_MS);
        child.once('exit', done);
        child.stdin.end();
      });
    }

    constructor(lease: ResourceLease) {
      if (!source.stdioCmd) throw new Error('Expected stdio source');
      this.close = children.track(() =>
        releaseAfterCleanup(
          (async () => {
            if (!this.closed) {
              this.closed = true;
              this.onclose?.();
            }
            await this.stop?.();
          })(),
          () => {
            lease.release();
            this.cleanedUp = true;
          },
        ),
      );
    }
  }

  class LeasedUpstream implements ModernChild {
    onmessage?: (message: JSONRPCMessage) => void;
    onerror?: (error: Error) => void;
    onclose?: () => void;
    private readonly aborting = new AbortController();
    private readonly sending = new Set<Promise<void>>();
    private readonly reading = new Set<Promise<void>>();
    private held: Promise<void> | undefined;
    private closed = false;
    close: () => Promise<void>;
    cleanedUp = false;

    async start(): Promise<void> {}

    hold(drainedPromise: Promise<void> | undefined): void {
      this.held = drainedPromise;
    }

    async send(message: JSONRPCMessage): Promise<void> {
      const pending = this.sendInternal(message);
      this.sending.add(pending);
      try {
        await pending;
      } finally {
        this.sending.delete(pending);
      }
    }

    private async sendInternal(message: JSONRPCMessage): Promise<void> {
      if (this.closed || !source.upstream) throw new Error('Upstream request is closed');
      const call = 'method' in message && message.method === 'tools/call';
      const response = await fetch(source.upstream.url, {
        method: 'POST',
        redirect: 'error',
        signal: this.aborting.signal,
        headers: {
          ...source.upstream.headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.declared.version === undefined
            ? {}
            : { 'mcp-protocol-version': encodedHeader(this.declared.version) }),
          ...mirroredHeaders(message),
          ...(call ? this.declared.params : {}),
        },
        body: JSON.stringify(message),
      });
      const awaited = 'id' in message && 'method' in message ? message.id : undefined;
      const reading = this.read(boundedBackendResponse(response), awaited)
        .catch((error: unknown) => this.fail(error))
        .finally(() => {
          this.reading.delete(reading);
        });
      this.reading.add(reading);
    }

    async finish(): Promise<void> {
      await Promise.all(this.reading);
    }

    private fail(error: unknown): void {
      if (this.closed) return;
      logger.error('Upstream request failed:', error);
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }

    private async read(response: Response, awaited?: string | number): Promise<void> {
      const type = response.headers.get('content-type') ?? '';
      let answered = awaited === undefined;
      const deliver = (value: unknown) => {
        const message = JSONRPCMessageSchema.parse(value);
        if ('id' in message && !('method' in message) && message.id === awaited) answered = true;
        this.onmessage?.(message);
      };
      if (type.includes('text/event-stream')) await this.events(response, deliver);
      else if (type.includes('application/json')) deliver(await response.json());
      else if (!response.ok) throw new Error(`The remote server answered ${response.status}`);
      if (!answered) throw new Error('The remote server ended its answer without a reply');
    }

    private async events(response: Response, deliver: (value: unknown) => void): Promise<void> {
      if (!response.body) throw new Error('Upstream event stream has no body');
      const parser = createParser({
        maxBufferSize: MAX_SSE_EVENT_BYTES,
        onError: (error) => {
          if (error.type === 'max-buffer-size-exceeded') throw new BackendOutputLimitError();
        },
        onEvent: ({ data }) => {
          if (Buffer.byteLength(data) > MAX_SSE_EVENT_BYTES) throw new BackendOutputLimitError();
          if (data) deliver(JSON.parse(data));
        },
      });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const feed = createLineFeed((text) => parser.feed(text));
      for await (const chunk of response.body) {
        feed(decoder.decode(chunk, { stream: true }));
        await this.held;
      }
      feed(decoder.decode());
      // Do not flush incomplete events; read() requires a fully framed reply.
    }

    constructor(
      lease: ResourceLease,
      private readonly declared: DeclaredSession,
    ) {
      if (!source.upstream) throw new Error('Expected upstream source');
      this.close = children.track(() =>
        releaseAfterCleanup(
          (async () => {
            if (!this.closed) {
              this.closed = true;
              this.aborting.abort();
              this.onclose?.();
            }
            // Abort alone does not settle pending fetches or body readers.
            await Promise.allSettled(this.sending);
            await Promise.allSettled(this.reading);
          })(),
          () => {
            lease.release();
            this.cleanedUp = true;
          },
        ),
      );
    }
  }

  const wrapLegacyResponse = (res: ServerResponse): GatewayResponse => {
    const wrapped = res as GatewayResponse;
    wrapped.status ??= (code: number) => {
      res.statusCode = code;
      return wrapped;
    };
    wrapped.send ??= (body: string) => {
      if (!res.headersSent && !res.destroyed) {
        const payload = Buffer.from(body, 'utf8');
        if (!res.getHeader('content-type'))
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Length', String(payload.byteLength));
        res.end(payload);
      }
      return wrapped;
    };
    wrapped.json ??= (body: unknown) => {
      if (!res.headersSent && !res.destroyed) {
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(payload.byteLength));
        res.end(payload);
      }
      return wrapped;
    };
    return wrapped;
  };

  try {
    const discovery = source.upstream ? new UpstreamDiscovery(source.upstream) : undefined;
    const speaks = discovery?.speaks ?? (() => true);
    const active = new Set<() => Promise<void>>();
    const retained = new RetainedChildren({
      idleMs: CONTINUATION_TIMEOUT,
      limit: RETAINED_CHILD_LIMIT,
      logger,
    });
    const sessions = server.legacyProtocol
      ? createSessions({
          source,
          children,
          calls,
          reserve: () => {
            const session = sessionAdmission.acquire();
            if (!session) throw new CapacityError();
            const resource = admission.acquire();
            if (!resource) {
              session.release();
              throw new CapacityError();
            }
            return [session, resource];
          },
          log: capture,
          logTraffic,
        })
      : undefined;

    const handlePost = async (req: GatewayRequest, res: ServerResponse): Promise<void> => {
      const value = headerValue(req);
      const route = await admit(req, res, value, speaks);
      if (res.destroyed || res.writableEnded || children.closing) return;
      if (typeof route === 'boolean') {
        // true: admission already answered. false: a session-protocol request.
        if (route) return;
        if (sessions) await sessions.post(req, wrapLegacyResponse(res));
        else rejectWith(req, res, 400, UNSUPPORTED_PROTOCOL_ERROR);
        return;
      }
      // The pinned admission also routes envelope-bearing requests that claim an
      // older revision, or initialize with a modern envelope, to the backend.
      if (
        route.classification.revision !== MODERN_VERSION ||
        route.message.method === 'initialize'
      ) {
        rejectWith(req, res, 400, UNSUPPORTED_PROTOCOL_ERROR);
        return;
      }
      const requestId = route.messageKind === 'request' ? route.message.id : undefined;
      const work = requestId === undefined ? undefined : calls.owner();
      if (work && requestId !== undefined && !calls.admit(work, requestId)) {
        // Still at the HTTP admission boundary, before any continuation is
        // taken or backend resource is reserved.
        rejectWith(req, res, 429, BACKEND_CAPACITY_ERROR);
        return;
      }
      let released = false;
      const releaseWork = () => {
        if (!work || released) return;
        released = true;
        calls.settleOwner(work);
      };
      let child: ModernChild | undefined;
      try {
        const transport = new WorkTransport((message) => {
          const id = 'id' in message ? message.id : undefined;
          if (
            requestId !== undefined &&
            (typeof id === 'string' || typeof id === 'number') &&
            id === requestId
          )
            releaseWork();
        });
        const params =
          route.messageKind === 'request' && isRecord(route.message.params)
            ? route.message.params
            : undefined;
        const continuation = params?.requestState;
        let reused: ReusedChild | undefined;
        if (isContinuationHandle(continuation)) {
          const waiting = new AbortController();
          const abort = () => waiting.abort();
          res.once('close', abort);
          try {
            reused = await retained.take(continuation, waiting.signal);
          } finally {
            res.off('close', abort);
          }
          if (!reused) {
            await transport.close();
            if (!res.destroyed) {
              rejectWith(req, res, 400, {
                code: -32602,
                message: 'Continuation expired or backend unavailable',
              });
            }
            return;
          }
        }
        child = reused?.child;
        if (!child) {
          let lease: ResourceLease | undefined;
          try {
            lease = reserve();
            child = source.stdioCmd
              ? new LeasedStdio(lease)
              : new LeasedUpstream(lease, {
                  version: value('mcp-protocol-version'),
                  params: paramHeaders(req),
                });
          } catch (error) {
            lease?.release();
            await transport.close();
            throw error;
          }
        }
        const request = new ModernRequest({
          req,
          res,
          route,
          value,
          transport,
          reused,
          child,
          retained,
          active,
          children,
          logger,
        });
        try {
          await request.serve();
        } finally {
          // Also cover a failed transport.start(), before serve's own finally.
          await request.stop();
        }
      } finally {
        // Refusals before a child exists cannot have dispatched backend work. Otherwise a
        // terminal reply already ended this work, or only the owned child's confirmed
        // cleanup frees its slot, also when serve() rejected.
        if (!child || cleanupConfirmed(child)) releaseWork();
      }
    };

    return {
      handle: async (req, res) => {
        if (children.closing) {
          res.statusCode = 503;
          res.end();
          return;
        }
        try {
          if (req.method === 'POST') {
            await handlePost(req as GatewayRequest, res);
            return;
          }
          if (sessions && (req.method === 'GET' || req.method === 'DELETE')) {
            await sessions.request(req as GatewayRequest, wrapLegacyResponse(res));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (error) {
          if (error instanceof CapacityError) {
            res.statusCode = 429;
            res.end();
          } else {
            diagnostic(error);
            if (res.headersSent) res.destroy();
            else {
              res.statusCode = 502;
              res.end();
            }
          }
        }
      },
      close: async () => {
        closing = true;
        const cleanup = [
          discovery?.close(),
          retained.close(),
          ...[...active].map((stop) => stop()),
          children.close(),
        ];
        await Promise.all(cleanup);
      },
    };
  } catch (error) {
    diagnostic(error);
    throw failure('BackendFailure', 'The backend mount could not be created.');
  }
};

const validExit = (code: string, signal: string): boolean => {
  return (
    (code === 'null' || (Number(code) >= -1 && Number(code) <= 255)) &&
    (signal === 'null' || Object.hasOwn(constants.signals, signal))
  );
};

const ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EADDRINUSE',
  'ENOTFOUND',
]);

// Reads a data property without invoking getters. The result keeps the descriptor's `any` type.
const own = (value: object, key: string) => Object.getOwnPropertyDescriptor(value, key)?.value;

const exitSummary = (text: string): string | undefined => {
  const exit = /^Child exited: code=(-?\d+|null), signal=(SIG[A-Z0-9]+|null)$/.exec(text);
  if (!exit || !validExit(exit[1], exit[2])) return undefined;
  return `Backend process exited (code ${exit[1]}, signal ${exit[2]}). Open Logs for details.`;
};

/** Only allowlisted codes and numeric statuses may enter status summaries. */
export const backendSummary = (args: readonly unknown[]): string => {
  const pending = [...args];
  const seen = new Set<object>();
  for (let index = 0; index < Math.min(pending.length, 16); index++) {
    const value = pending[index];
    if (value && typeof value === 'object') {
      if (seen.has(value)) continue;
      seen.add(value);
      try {
        const cause = own(value, 'cause');
        if (cause) pending.push(cause);
        const code = own(value, 'code');
        if (typeof code === 'string' && ERROR_CODES.has(code))
          return `Backend failed (${code}). Check the executable, permissions or connection. Open Logs for details.`;
        const status = own(value, 'status') ?? (typeof code === 'number' ? code : undefined);
        if (Number.isInteger(status) && status >= 400 && status <= 599)
          return `Backend HTTP request failed (${status}). Open Logs for details.`;
        const message = own(value, 'message');
        if (typeof message === 'string') {
          const remote = /^The remote server answered ([45]\d{2})$/.exec(message);
          if (remote) return `Backend HTTP request failed (${remote[1]}). Open Logs for details.`;
          const http = /^Streamable HTTP error: Error POSTing to endpoint: ([45]\d{2})\b/.exec(
            message,
          );
          if (http) return `Backend HTTP request failed (${http[1]}). Open Logs for details.`;
          const exit = exitSummary(message);
          if (exit) return exit;
        }
      } catch {
        /* Unreadable diagnostics still remain a generic failure. */
      }
    }
    if (typeof value === 'string') {
      const exit = exitSummary(value);
      if (exit) return exit;
    }
  }
  return 'A backend operation failed. Open Logs for details.';
};

// Deadlines bound each wait, not ownership of the underlying cleanup. A raw
// rejection is unconfirmed cleanup and must remain a failure on every retry.
const mountClosures = new WeakMap<GatewayMount, Promise<void>>();

export const closeMount = async (
  mount: GatewayMount,
  onFailure?: (error: unknown) => void,
): Promise<void> => {
  let completion = mountClosures.get(mount);
  if (!completion) {
    completion = Promise.resolve().then(() => mount.close());
    mountClosures.set(mount, completion);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(failure('ShutdownFailure', 'Backend cleanup exceeded its deadline.')),
          SHUTDOWN_MS,
        );
      }),
    ]);
  } catch (error) {
    onFailure?.(error);
    throw failure('ShutdownFailure', 'Backend cleanup did not complete successfully.');
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_ID = 'mcp-gateway-discover';

const discoveryResult = (data: string): boolean | undefined => {
  const message = JSONRPCMessageSchema.parse(JSON.parse(data));
  if (!('id' in message) || 'method' in message || message.id !== DISCOVERY_ID) return undefined;
  if (!('result' in message)) return false;
  const versions = message.result.supportedVersions;
  return (
    Array.isArray(versions) &&
    versions.every((version) => typeof version === 'string') &&
    versions.includes(MODERN_VERSION)
  );
};

/** Pinned capability check with explicit cancellation and bounded input. */
class UpstreamDiscovery {
  private readonly lifetime = new AbortController();
  private last: { at: number; result: Promise<boolean> } | undefined;

  constructor(private readonly upstream: Upstream) {}

  readonly speaks = (): Promise<boolean> => {
    if (this.lifetime.signal.aborted) return Promise.resolve(false);
    if (this.last && Date.now() - this.last.at < SPEAKS_FOR_MS) return this.last.result;
    const last = {
      at: Date.now(),
      result: this.discover().then((speaks) => {
        // A failed check is not an answer: ask again on the next request.
        if (speaks === undefined && this.last === last) this.last = undefined;
        return speaks ?? false;
      }),
    };
    this.last = last;
    return last.result;
  };

  async close(): Promise<void> {
    this.lifetime.abort();
    await this.last?.result;
  }

  /** Undefined when the upstream could not be asked: no connection, a timeout or a 5xx. */
  private async discover(): Promise<boolean | undefined> {
    try {
      let response: Response;
      try {
        response = await fetch(this.upstream.url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
          ]),
          headers: {
            ...this.upstream.headers,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MODERN_VERSION,
            'mcp-method': 'server/discover',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: DISCOVERY_ID,
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
                'io.modelcontextprotocol/clientInfo': {
                  name: 'mcp-gateway',
                  version: '0.9.0',
                },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        });
      } catch {
        return undefined;
      }
      if (!response.body) return response.status >= 500 ? undefined : false;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let result: boolean | undefined;
      const parser = response.headers.get('content-type')?.includes('text/event-stream')
        ? createParser({
            maxBufferSize: MAX_DISCOVERY_BYTES,
            onError: (error) => {
              if (error.type === 'max-buffer-size-exceeded') throw new BackendOutputLimitError();
            },
            onEvent: ({ data }) => {
              if (data && result === undefined) result = discoveryResult(data);
            },
          })
        : undefined;
      const feed = createLineFeed((text) => parser?.feed(text));
      let length = 0;
      try {
        if (!response.ok) return response.status >= 500 ? undefined : false;
        for (;;) {
          // A timeout or reset mid-body is not an answer: ask again on the next request.
          const read = await reader.read().catch(() => undefined);
          if (!read) return undefined;
          const { value, done } = read;
          if (done) break;
          length += value.byteLength;
          if (length > MAX_DISCOVERY_BYTES) return false;
          if (parser) {
            feed(decoder.decode(value, { stream: true }));
            if (result !== undefined) return result;
          } else chunks.push(value);
        }
        if (!parser) return discoveryResult(decoder.decode(Buffer.concat(chunks))) ?? false;
        // Finish UTF-8 decoding, but never dispatch an incomplete SSE frame.
        feed(decoder.decode());
        return result ?? false;
      } finally {
        try {
          // Cancelling an errored body rejects; that must not replace the result above.
          await reader.cancel().catch(() => undefined);
        } finally {
          reader.releaseLock();
        }
      }
    } catch {
      // Per the pinned discovery contract, failure/unsupported responses select
      // legacy handling. Never publish a remote error, response or credential.
      return false;
    }
  }
}
