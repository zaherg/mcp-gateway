import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  isJSONRPCRequest,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

import { failure, sanitizeErrorText } from '@mcp-gateway/core/errors';
import {
  BACKEND_CAPACITY_ERROR,
  type BackendCalls,
  boundedBackendResponse,
  type ResourceLease,
  readBackendLines,
  releaseAfterCleanup,
  type WorkOwner,
} from '@mcp-gateway/core/limits';
import { type BackendProcesses, childEnvironment } from '@mcp-gateway/core/process';
import type { LogLevel } from '@mcp-gateway/shared/types';

// Session-based MCP (2025-11-25 and earlier) for endpoints that opt in.
// SessionMultiplexer owns the protocol: initialize, Mcp-Session-Id, the GET
// event stream and DELETE. Each session holds a session slot and a backend
// resource lease until its backend's cleanup is confirmed, client requests are
// charged to the shared backend-call budget, and backend output is bounded.

/** A session with no open request or event stream ends after this long. */
const SESSION_IDLE_MS = 60_000;

/** Unanswered cancelled calls a session may hold before it is closed to free them. */
const MAX_CANCELLED_CALLS = 4;

const DUPLICATE_REQUEST_ERROR = {
  code: -32600,
  message: 'A request with this id is already in flight in this session.',
} as const;

export interface GatewayRequest extends IncomingMessage {
  body?: unknown;
}

export interface GatewayResponse extends ServerResponse {
  status(code: number): GatewayResponse;
  send(body: string): GatewayResponse;
  json(body: unknown): GatewayResponse;
}

export interface GatewayLogger {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface Command {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface Upstream {
  type: 'streamableHttp';
  url: URL;
  headers?: Record<string, string>;
}

export type Source =
  | { stdioCmd: Command; upstream?: never }
  | { upstream: Upstream; stdioCmd?: never };

export interface ChildrenOwner {
  readonly closing: boolean;
  readonly spawnOptions: SpawnOptions;
  own(child: ChildProcess): () => Promise<void>;
  track(stop: () => Promise<void>): () => Promise<void>;
}

export interface PeerOwner {
  failure(kind: string, error: Error): void;
  exit(code: number | null, signal: string | null): void;
  message(message: JSONRPCMessage, line: string): void;
  nonJson(line: string): void;
  stderr(text: string): void;
  output(): Promise<void> | undefined;
}

export interface Peer {
  write(message: JSONRPCMessage): void;
  end(): void;
  stop(): Promise<void>;
  readonly gone: boolean;
}

export type PeerFactory = (owner: PeerOwner) => Peer;

export interface SessionMultiplexer {
  post(req: GatewayRequest, res: GatewayResponse): Promise<void>;
  request(req: GatewayRequest, res: GatewayResponse): Promise<void>;
}

interface JsonRpcError {
  code: number;
  message: string;
}

type SessionLog = (level: LogLevel, args: unknown[], diagnose: boolean) => void;

interface SessionOptions {
  source: Source;
  children: BackendProcesses;
  calls: BackendCalls;
  /** Leases held until the session's backend cleanup is confirmed; throws when refused. */
  reserve: () => ResourceLease[];
  log: SessionLog;
  logTraffic?: boolean;
}

// Only backend failures of a live session reach the endpoint status. Transport
// and bookkeeping errors are caused by clients, and a child exiting after its
// session closed is the expected end.
const BACKEND_FAILURE = /^Child (exited|process failure|non-JSON)/;

const sessionLogger = (log: SessionLog, ended: () => boolean): GatewayLogger => {
  return {
    info: (...args) => log('info', args, false),
    debug: (...args) => log('debug', args, false),
    warn: (...args) => log('warn', args, false),
    error: (...args) =>
      log('error', args, !ended() && typeof args[0] === 'string' && BACKEND_FAILURE.test(args[0])),
  };
};

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

const drained = (responses: Iterable<ServerResponse>): Promise<void> | undefined => {
  const full = [...responses].filter((res) => res.writableNeedDrain);
  if (full.length) return Promise.all(full.map(untilDrained)).then(() => {});
  return undefined;
};

export const readWhile = (response: Response, wait: () => Promise<void> | undefined): Response => {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const held = new Response(
    new ReadableStream({
      async pull(controller) {
        await wait();
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
  Object.defineProperties(held, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return held;
};

const failPendingCalls = ({
  transport,
  pending,
  res,
  logger,
}: {
  transport: StreamableHTTPServerTransport;
  pending: Set<string | number>;
  res: GatewayResponse;
  logger: GatewayLogger;
}): void => {
  const replies = [...pending].map((id) =>
    transport
      .send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'MCP server process failed' },
      })
      .catch((sendError) => {
        logger.error('Failed to send child failure', sendError);
      }),
  );
  pending.clear();
  void Promise.all(replies)
    .then(() => transport.close())
    .catch((closeError) => {
      logger.error('Failed to close transport after child failure', closeError);
    })
    .finally(() => {
      if (!res.writableEnded) res.destroy();
    });
};

class SessionLivenessProbe {
  private readonly idPrefix = `mcp-gateway-ping:${randomUUID()}:`;
  private nextId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private active = false;
  private closed = false;
  private revision = 0;
  private missed = 0;
  private activeRequests = 0;
  private answered = false;
  private staleEligible = false;
  private firstProbe = false;

  constructor(
    private readonly intervalMs: number,
    private readonly replyTimeoutMs: number,
    private readonly staleAfterMs: number,
    private readonly send: (id: string) => Promise<void>,
    private readonly stale: () => void,
    private readonly logger: GatewayLogger,
  ) {}

  start(): boolean {
    if (this.active || this.closed) return false;
    this.active = true;
    this.missed = 0;
    this.firstProbe = true;
    this.resetGrace();
    if (!this.activeRequests) this.schedule();
    return true;
  }

  stop(): void {
    this.active = false;
    this.revision++;
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  private activity(): void {
    if (!this.active) return;
    this.missed = 0;
    this.resetGrace();
    this.revision++;
    clearTimeout(this.timer);
    if (!this.activeRequests) this.schedule();
  }

  requestStarted(): void {
    this.activeRequests++;
    this.activity();
  }

  requestFinished(): void {
    if (this.activeRequests) this.activeRequests--;
    this.activity();
  }

  accept(message: JSONRPCMessage): boolean {
    if (
      !('id' in message) ||
      'method' in message ||
      typeof message.id !== 'string' ||
      !message.id.startsWith(this.idPrefix)
    )
      return false;
    this.answered = true;
    this.activity();
    return true;
  }

  private schedule(): void {
    this.revision++;
    clearTimeout(this.timer);
    const revision = this.revision;
    this.timer = setTimeout(
      () => {
        if (this.active && this.revision === revision) this.probe();
      },
      this.firstProbe ? Math.min(this.intervalMs, 5_000) : this.intervalMs,
    );
    this.timer.unref();
  }

  private resetGrace(): void {
    clearTimeout(this.graceTimer);
    this.staleEligible = false;
    this.graceTimer = setTimeout(() => {
      this.staleEligible = true;
    }, this.staleAfterMs);
    this.graceTimer.unref();
  }

  private probe(): void {
    this.firstProbe = false;
    const id = `${this.idPrefix}${++this.nextId}`;
    const revision = ++this.revision;
    this.logger.info('Sending session liveness ping');
    void this.send(id)
      .then(() => {
        if (!this.active || this.revision !== revision) return;
        this.timer = setTimeout(() => this.miss(revision), this.replyTimeoutMs);
        this.timer.unref();
      })
      .catch((error) => {
        if (!this.active || this.revision !== revision) return;
        this.logger.error('Failed to send session liveness ping:', error);
        this.miss(revision);
      });
  }

  private miss(revision: number): void {
    if (!this.active || this.revision !== revision) return;
    if (++this.missed < 2) {
      this.probe();
      return;
    }
    if (!this.answered) {
      this.logger.info(
        'Client has not answered liveness pings; preserving session for compatibility',
      );
      this.stop();
      return;
    }
    if (!this.staleEligible) {
      this.schedule();
      return;
    }
    this.logger.info('Closing session after two unanswered liveness pings');
    this.stop();
    this.stale();
  }
}

class SessionAccessCounter {
  private readonly sessions = new Map<
    string,
    { accessCount: number } | { timeout: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly timeout: number,
    private readonly cleanup: (sessionId: string) => void,
    private readonly logger: GatewayLogger,
  ) {}

  inc(sessionId: string, reason: string): void {
    this.logger.info(`SessionAccessCounter.inc() ${sessionId}, caused by ${reason}`);
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sessions.set(sessionId, { accessCount: 1 });
      return;
    }
    if ('timeout' in session) {
      clearTimeout(session.timeout);
      this.sessions.set(sessionId, { accessCount: 1 });
    } else {
      session.accessCount++;
    }
  }

  dec(sessionId: string, reason: string): void {
    this.logger.info(`SessionAccessCounter.dec() ${sessionId}, caused by ${reason}`);
    const session = this.sessions.get(sessionId);
    if (!session || 'timeout' in session) return;
    if (session.accessCount <= 0) {
      throw new Error(`Invalid access count ${session.accessCount} for session ${sessionId}`);
    }
    session.accessCount--;
    if (session.accessCount === 0) {
      const timeout = setTimeout(() => {
        this.sessions.delete(sessionId);
        this.cleanup(sessionId);
      }, this.timeout);
      timeout.unref();
      this.sessions.set(sessionId, { timeout });
    }
  }

  clear(sessionId: string, runCleanup: boolean, reason: string): void {
    this.logger.info(`SessionAccessCounter.clear() ${sessionId}, caused by ${reason}`);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if ('timeout' in session) clearTimeout(session.timeout);
    this.sessions.delete(sessionId);
    if (runCleanup) this.cleanup(sessionId);
  }
}

class ManagedSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly probe: SessionLivenessProbe;
  readonly responses = new Set<GatewayResponse>();
  private initializedSessionId?: string;
  private readonly pendingRequests = new Set<string | number>();
  private readonly progressOf = new Map<unknown, string | number>();
  private readonly peer: Peer;
  private childStopped = false;
  private childFailed = false;

  static async open(
    sessions: DirectSessions,
    res: GatewayResponse,
    logger: GatewayLogger,
    sessionTimeout: number,
    begin: (
      transport: StreamableHTTPServerTransport,
      responses: Set<GatewayResponse>,
    ) => PeerFactory,
  ): Promise<ManagedSession> {
    let session!: ManagedSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => session.initialized(sessionId),
    });
    const probe = new SessionLivenessProbe(
      Math.max(5_000, Math.min(sessionTimeout, 300_000)),
      Math.max(5_000, Math.min(sessionTimeout, 30_000)),
      sessionTimeout,
      async (id) => {
        await transport.send({ jsonrpc: '2.0', id, method: 'ping' });
      },
      () => {
        transport.close().catch((error) => {
          logger.error('Failed to close stale session:', error);
          session.stopChild('stale transport close failed');
        });
      },
      logger,
    );
    await transport.start();
    const responses = new Set<GatewayResponse>();
    const peerFactory = begin(transport, responses);
    session = new ManagedSession(sessions, res, logger, transport, probe, responses, peerFactory);
    return session;
  }

  private constructor(
    private readonly sessions: DirectSessions,
    private readonly res: GatewayResponse,
    private readonly logger: GatewayLogger,
    transport: StreamableHTTPServerTransport,
    probe: SessionLivenessProbe,
    responses: Set<GatewayResponse>,
    peerFactory: PeerFactory,
  ) {
    this.transport = transport;
    this.probe = probe;
    this.responses = responses;
    this.peer = peerFactory({
      failure: (_kind, err) => this.fail(err),
      exit: (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`);
        this.fail();
      },
      message: (jsonMsg, line) => this.fromChild(jsonMsg, line),
      nonJson: (line) => logger.error(`Child non-JSON: ${line}`),
      stderr: (text) => logger.error(`Child stderr: ${text}`),
      output: () => drained(this.responses),
    });
    transport.onmessage = (msg) => this.fromClient(msg);
    transport.onclose = () => {
      logger.info(
        `StreamableHttp connection closed (session ${this.initializedSessionId ?? '(uninitialized)'})`,
      );
      this.stopChild('transport being closed');
    };
    transport.onerror = (err) => {
      logger.error(
        `StreamableHttp error (session ${this.initializedSessionId ?? '(uninitialized)'}):`,
        err,
      );
    };
  }

  private initialized(sessionId: string): void {
    this.initializedSessionId = sessionId;
    this.sessions.register(sessionId, this.transport, this.probe);
  }

  private fromChild(jsonMsg: JSONRPCMessage, line: string): void {
    this.logger.info('Child → StreamableHttp:', line);
    if ('id' in jsonMsg && !('method' in jsonMsg)) {
      const id = jsonMsg.id;
      if (typeof id === 'string' || typeof id === 'number') this.settle(id);
    }
    this.transport
      .send(jsonMsg, {
        relatedRequestId: this.relatedRequest(jsonMsg),
      })
      .catch((e) => {
        this.logger.error('Failed to send to StreamableHttp', e);
      });
  }

  private relatedRequest(message: JSONRPCMessage): string | number | undefined {
    const own =
      'method' in message && message.method === 'notifications/progress'
        ? this.progressOf.get(
            (message.params as { progressToken?: unknown } | undefined)?.progressToken,
          )
        : undefined;
    return own ?? this.pendingRequests.values().next().value;
  }

  private settle(requestId: string | number): boolean {
    for (const [token, id] of this.progressOf) {
      if (id === requestId) this.progressOf.delete(token);
    }
    return this.pendingRequests.delete(requestId);
  }

  private fromClient(msg: JSONRPCMessage): void {
    if (this.probe.accept(msg)) return;
    if ('id' in msg && 'method' in msg) {
      this.pendingRequests.add(msg.id);
      const token = (msg.params as { _meta?: { progressToken?: unknown } } | undefined)?._meta
        ?.progressToken;
      if (token !== undefined) this.progressOf.set(token, msg.id);
    }
    this.logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`);
    this.peer.write(msg);
    if ('method' in msg && msg.method === 'notifications/cancelled') {
      const requestId = (msg.params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number')
        this.endCancelled(requestId);
    }
  }

  private endCancelled(requestId: string | number): void {
    if (!this.settle(requestId)) return;
    if (typeof this.transport.closeSSEStream === 'function')
      this.transport.closeSSEStream(requestId);
  }

  stopChild(reason: string): void {
    if (this.childStopped) return;
    this.childStopped = true;
    if (this.initializedSessionId) this.sessions.forget(this.initializedSessionId, reason);
    this.probe.close();
    void this.peer.stop();
  }

  private fail(err?: Error): void {
    if (this.childFailed) return;
    this.childFailed = true;
    if (err) this.logger.error('Child process failure:', err);
    this.stopChild('child process failure');
    failPendingCalls({
      transport: this.transport,
      pending: this.pendingRequests,
      res: this.res,
      logger: this.logger,
    });
  }
}

const rejectSession = (res: GatewayResponse, sessionId: string | string[] | undefined): void => {
  if (sessionId) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found',
      },
      id: null,
    });
    return;
  }
  res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Bad Request: No valid session ID provided',
    },
    id: null,
  });
};

class DirectSessions implements SessionMultiplexer {
  readonly transports = new Map<string, StreamableHTTPServerTransport>();
  readonly liveness = new Map<string, SessionLivenessProbe>();
  readonly openResponses = new WeakMap<StreamableHTTPServerTransport, Set<GatewayResponse>>();
  private readonly counter: SessionAccessCounter;

  constructor(
    protected readonly logger: GatewayLogger,
    protected readonly sessionTimeout: number,
    private readonly openTransport: (
      res: GatewayResponse,
    ) => Promise<StreamableHTTPServerTransport>,
  ) {
    this.counter = new SessionAccessCounter(
      sessionTimeout,
      (sessionId) => this.timedOut(sessionId),
      logger,
    );
  }

  private timedOut(sessionId: string): void {
    this.logger.info(`Session ${sessionId} timed out, cleaning up`);
    const transport = this.transports.get(sessionId);
    transport?.close().catch((err) => {
      this.logger.error(`Failed to close timed-out session ${sessionId}`, err);
    });
    this.transports.delete(sessionId);
  }

  register(
    sessionId: string,
    transport: StreamableHTTPServerTransport,
    probe: SessionLivenessProbe,
  ): void {
    this.liveness.set(sessionId, probe);
    this.transports.set(sessionId, transport);
    this.counter.inc(sessionId, 'session initialization');
  }

  forget(sessionId: string, reason: string): void {
    this.liveness.delete(sessionId);
    this.counter.clear(sessionId, false, reason);
    this.transports.delete(sessionId);
  }

  private countResponse(
    res: GatewayResponse,
    method: string,
    sessionId: () => string | undefined,
    ended?: (id: string) => void,
  ): void {
    let responseEnded = false;
    const handleResponseEnd = (event: string) => {
      const id = sessionId();
      if (responseEnded || !id) return;
      responseEnded = true;
      this.logger.info(`Response ${event}`, id);
      if (this.transports.has(id)) this.counter.dec(id, `${method} response ${event}`);
      ended?.(id);
    };
    res.on('finish', () => handleResponseEnd('finished'));
    res.on('close', () => handleResponseEnd('closed'));
  }

  private watch(transport: StreamableHTTPServerTransport, res: GatewayResponse): void {
    const responses = this.openResponses.get(transport);
    if (!responses) return;
    responses.add(res);
    res.once('close', () => responses.delete(res));
  }

  async post(req: GatewayRequest, res: GatewayResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    let transport: StreamableHTTPServerTransport | undefined;
    if (typeof sessionId === 'string' && this.transports.has(sessionId)) {
      transport = this.transports.get(sessionId);
      this.liveness.get(sessionId)?.requestStarted();
      this.counter.inc(sessionId, 'POST request for existing session');
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = await this.openTransport(res);
    } else {
      rejectSession(res, sessionId);
      return;
    }
    if (!transport) return;
    const activeTransport = transport;
    this.countResponse(
      res,
      'POST',
      () => activeTransport.sessionId,
      (id) => this.liveness.get(id)?.requestFinished(),
    );
    this.watch(activeTransport, res);
    await activeTransport.handleRequest(req, res, req.body);
  }

  async request(req: GatewayRequest, res: GatewayResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !sessionId) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }
    this.counter.inc(sessionId, `${req.method ?? 'GET'} request for existing session`);
    if (req.method === 'GET') {
      const probe = this.liveness.get(sessionId);
      if (probe?.start()) {
        res.once('finish', () => probe.stop());
        res.once('close', () => probe.stop());
      }
    }
    this.countResponse(res, req.method ?? 'GET', () => sessionId);
    this.watch(transport, res);
    await transport.handleRequest(req, res);
  }
}

export const createSessions = (options: SessionOptions): SessionMultiplexer => {
  const { source, children, calls, reserve, log, logTraffic = false } = options;
  const localFailure = (error: unknown) => log('error', [error], false);
  const workByTransport = new WeakMap<StreamableHTTPServerTransport, WorkOwner>();

  // Session bookkeeping logs several info lines per request; they would push
  // useful entries out of the bounded Logs buffer. Keep its warnings and errors.
  const bookkeeping: GatewayLogger = {
    ...sessionLogger(log, () => true),
    info: () => {},
    debug: () => {},
  };

  let sessions!: DirectSessions;
  const open = async (res: GatewayResponse): Promise<StreamableHTTPServerTransport> => {
    if (children.closing) throw failure('Closed', 'The backend is closing.');
    const leases = reserve();
    const work = calls.owner();
    const release = () => {
      for (const lease of leases) lease.release();
      calls.settleOwner(work);
    };
    let transport: StreamableHTTPServerTransport | undefined;
    let transportClosed = false;
    let ended = false;
    let cleanup: (() => Promise<void>) | undefined;
    const end = () => {
      ended = true;
      // A failed or abandoned initialize never yields a usable session; close
      // only its own transport so its backend and leases are released.
      if (transport && (!res.writableFinished || res.statusCode >= 400 || !transport.sessionId))
        void transport.close().catch(localFailure);
    };
    res.once('finish', end);
    res.once('close', end);
    const logger = sessionLogger(log, () => transportClosed || children.closing);
    try {
      const session = await ManagedSession.open(
        sessions,
        res,
        logger,
        SESSION_IDLE_MS,
        (opened, responses) => {
          transport = opened;
          if (children.closing || ended) throw failure('Closed', 'The request ended.');
          sessions.openResponses.set(opened, responses);
          const owner = leasedOwner(children, release, localFailure, (stop) => {
            cleanup = stop;
          });
          let overloaded = false;
          return charged(startBackend(source, owner, logger, logTraffic), work, calls, () => {
            if (overloaded) return;
            overloaded = true;
            log('warn', ['Session: closed after too many unanswered cancelled calls.'], false);
            // Deferred: this runs while the session is still handling the
            // cancellation that crossed the limit.
            void Promise.resolve()
              .then(() => opened.close())
              .catch(localFailure);
          });
        },
      );
      transport = session.transport;
      workByTransport.set(transport, work);
      const onclose = transport.onclose;
      transport.onclose = () => {
        // Set before the session stops its child, so that exit is not a failure.
        transportClosed = true;
        onclose?.();
      };
      if (ended) end();
      return transport;
    } catch (error) {
      res.off('finish', end);
      res.off('close', end);
      await transport?.close();
      if (cleanup) await cleanup();
      else release();
      throw error;
    }
  };

  sessions = new DirectSessions(bookkeeping, SESSION_IDLE_MS, open);

  return {
    // A request whose response ended early (the request deadline or a client
    // disconnect) is cancelled the way a client cancel is. The call stays
    // charged until its backend answers or the session's cleanup ends it.
    post: async (req: GatewayRequest, res: GatewayResponse): Promise<void> => {
      const sessionId = req.headers['mcp-session-id'];
      const transport =
        typeof sessionId === 'string' ? sessions.transports.get(sessionId) : undefined;
      const work = transport && workByTransport.get(transport);
      const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
      const ids = messages.flatMap((message) => (isJSONRPCRequest(message) ? [message.id] : []));
      if (transport && work && ids.length)
        res.once('close', () => {
          if (res.writableFinished || sessions.transports.get(sessionId as string) !== transport)
            return;
          for (const requestId of ids)
            if (calls.holds(work, requestId))
              transport.onmessage?.({
                jsonrpc: '2.0',
                method: 'notifications/cancelled',
                params: { requestId, reason: 'The HTTP request ended before its reply.' },
              });
        });
      await sessions.post(req, res);
    },
    request: (req: GatewayRequest, res: GatewayResponse): Promise<void> =>
      sessions.request(req, res),
  };
};

// Release happens only after confirmed process-group absence or upstream
// session cleanup; an unconfirmed cleanup keeps its leases for a retry.
const leasedOwner = (
  children: BackendProcesses,
  release: () => void,
  report: (error: unknown) => void,
  registered: (stop: () => Promise<void>) => void,
): ChildrenOwner => {
  const track = (stop: () => Promise<void>) => {
    const owned = children.track(() => releaseAfterCleanup(stop(), release));
    registered(owned);
    return owned;
  };
  return {
    get closing() {
      return children.closing;
    },
    spawnOptions: children.spawnOptions,
    own: (child) => {
      const stop = track(children.own(child));
      child.once('exit', () => {
        void stop().catch(report);
      });
      return stop;
    },
    track,
  };
};

// Charges each client request to the shared budget when it reaches the backend
// and settles it on the backend's reply or the session's confirmed cleanup.
// A cancellation does not settle: MCP servers send nothing for a cancelled call,
// so the backend may still be working on it. A session that accumulates
// MAX_CANCELLED_CALLS such calls is ended through `overloaded`, and its cleanup
// settles them. Refusals go through the session's own message path so its
// pending-request bookkeeping is cleared.
const charged = (
  factory: PeerFactory,
  work: WorkOwner,
  calls: BackendCalls,
  overloaded: () => void,
): PeerFactory => {
  return (owner) => {
    const cancelled = new Set<string | number>();
    const refuse = (id: string | number, error: JsonRpcError) => {
      const response = { jsonrpc: '2.0' as const, id, error };
      owner.message(response, JSON.stringify(response));
    };
    const peer = factory({
      ...owner,
      message: (message, line) => {
        if (!('method' in message) && 'id' in message) {
          const id = message.id;
          if (typeof id === 'string' || typeof id === 'number') {
            cancelled.delete(id);
            calls.settle(work, id);
          }
        }
        owner.message(message, line);
      },
    });
    return {
      write: (message) => {
        if ('method' in message && 'id' in message) {
          if (calls.holds(work, message.id)) {
            refuse(message.id, DUPLICATE_REQUEST_ERROR);
            return;
          }
          if (!calls.admit(work, message.id)) {
            refuse(message.id, BACKEND_CAPACITY_ERROR);
            return;
          }
        }
        peer.write(message);
        if ('method' in message && message.method === 'notifications/cancelled') {
          const id = (message.params as { requestId?: unknown } | undefined)?.requestId;
          if ((typeof id === 'string' || typeof id === 'number') && calls.holds(work, id)) {
            cancelled.add(id);
            if (cancelled.size >= MAX_CANCELLED_CALLS) overloaded();
          }
        }
      },
      end: () => peer.end(),
      stop: () => peer.stop(),
      get gone() {
        return peer.gone;
      },
    };
  };
};

// Direct process and upstream peers with the 4 MiB output bound applied
// before their otherwise unbounded readers.
const startBackend = (
  source: Source,
  children: ChildrenOwner,
  logger: GatewayLogger,
  logTraffic = false,
): PeerFactory => {
  if (source.stdioCmd) {
    const child = spawn(source.stdioCmd.command, source.stdioCmd.args, {
      ...children.spawnOptions,
      cwd: source.stdioCmd.cwd,
      env: childEnvironment(source.stdioCmd.env),
      stdio: 'pipe',
      shell: false,
    });
    const stop = children.own(child);
    return (owner) => {
      child.on('error', (error) => owner.failure('process', error));
      child.stdin.on('error', (error) => owner.failure('stdin', error));
      child.stdout.on('error', (error) => owner.failure('stdout', error));
      child.on('exit', (code, signal) => owner.exit(code, signal));
      readBackendLines(
        child.stdout,
        (line) => {
          if (!line.trim()) return;
          try {
            owner.message(JSON.parse(line), line);
          } catch {
            owner.nonJson(line);
          }
        },
        (error) => owner.failure('stdout', error),
        () => owner.output(),
      );
      if (logTraffic) {
        child.stderr.on('data', (chunk) => owner.stderr(chunk.toString('utf8')));
      } else {
        let stderrReported = false;
        child.stderr.on('data', () => {
          if (stderrReported) return;
          stderrReported = true;
          owner.stderr(
            'Child stderr output suppressed (enable traffic logging or inspect redacted diagnostics).',
          );
        });
      }
      return {
        write: (message) => {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        end: () => {
          child.stdin.end();
        },
        stop,
        get gone() {
          return child.exitCode !== null || child.signalCode !== null;
        },
      };
    };
  }
  const remote = source.upstream;
  return (owner) => {
    let gone = false;
    let initializeId: string | number | undefined;
    let answered: (() => void) | undefined;
    const fail = (error: unknown) =>
      owner.failure('upstream', new Error(sanitizeErrorText(error, 'Upstream request failed.')));
    // The upstream sees only its configured headers, never the client's token.
    const transport = new StreamableHTTPClientTransport(remote.url, {
      requestInit: { headers: remote.headers },
      fetch: async (url, init) =>
        readWhile(
          boundedBackendResponse(await fetch(url, { ...init, redirect: 'error' }), fail),
          () => owner.output(),
        ),
    });
    const stop = children.track(async () => {
      // Bounded: an unresponsive upstream must not hold up the session's end.
      await Promise.race([
        transport
          .terminateSession()
          .catch((error) =>
            logger.error(
              'Session: failed to end the upstream session:',
              sanitizeErrorText(error, 'Upstream session termination failed.'),
            ),
          ),
        delay(2000, undefined, { ref: false }),
      ]);
      await transport.close();
    });
    transport.onmessage = (message) => {
      if ('id' in message && message.id === initializeId) {
        initializeId = undefined;
        if ('result' in message) {
          if (typeof message.result.protocolVersion !== 'string') {
            fail(new Error('Upstream initialization has no protocol version.'));
            return;
          }
          transport.setProtocolVersion(message.result.protocolVersion);
        }
        answered?.();
      }
      owner.message(message, JSON.stringify(message));
    };
    transport.onerror = (error) =>
      logger.error('Session: upstream error:', sanitizeErrorText(error, 'Upstream error.'));
    transport.onclose = () => {
      gone = true;
      owner.exit(null, null);
    };
    // Everything waits for the connection; after initialize, also for its
    // answer, which sets the protocol version later requests declare.
    let ready = transport.start().catch(fail);
    return {
      write: (message) => {
        const sent = ready.then(() => transport.send(message));
        void sent.catch(fail);
        if (!isInitializeRequest(message) || !('id' in message)) return;
        initializeId = message.id;
        ready = Promise.all([
          sent,
          new Promise<void>((resolve) => {
            answered = resolve;
          }),
        ]).then(() => undefined, fail);
      },
      end: () => {
        void ready.then(stop).catch(fail);
      },
      stop,
      get gone() {
        return gone;
      },
    };
  };
};
