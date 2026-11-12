import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { StatefulSession } from 'supergateway/dist/gateways/statefulSession.js';
import { StatefulSessions } from 'supergateway/dist/gateways/statefulSessions.js';
import type {
  ChildrenOwner,
  GatewayLogger,
  GatewayRequest,
  GatewayResponse,
  PeerFactory,
  Source,
} from 'supergateway/dist/gateways/stdioToStatefulStreamableHttp.js';
import { spawnCommand } from 'supergateway/dist/lib/childCommand.js';
import { readWhile } from 'supergateway/dist/lib/outputBackpressure.js';

import { failure } from '@mcp-gateway/core/errors';
import {
  BACKEND_CAPACITY_ERROR,
  type BackendCalls,
  boundedBackendResponse,
  type ResourceLease,
  readBackendLines,
  releaseAfterCleanup,
  type WorkOwner,
} from '@mcp-gateway/core/limits';
import type { BackendProcesses } from '@mcp-gateway/core/process';
import type { LogLevel } from '@mcp-gateway/shared/types';

// Session-based MCP (2025-11-25 and earlier) for endpoints that opt in.
// Supergateway 4.2.1's StatefulSessions owns the protocol: initialize,
// Mcp-Session-Id, the GET event stream and DELETE. This module only puts the
// gateway's limits around it: each session holds a session slot and a backend
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

export const createSessions = (options: SessionOptions): StatefulSessions => {
  const { source, children, calls, reserve, log } = options;
  const localFailure = (error: unknown) => log('error', [error], false);

  class LeasedSessions extends StatefulSessions {
    private readonly work = new WeakMap<StreamableHTTPServerTransport, WorkOwner>();

    // A request whose response ended early (the request deadline or a client
    // disconnect) is cancelled the way a client cancel is. The call stays
    // charged until its backend answers or the session's cleanup ends it.
    override async post(req: GatewayRequest, res: GatewayResponse): Promise<void> {
      const sessionId = req.headers['mcp-session-id'];
      const transport = typeof sessionId === 'string' ? this.transports.get(sessionId) : undefined;
      const work = transport && this.work.get(transport);
      const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
      const ids = messages.flatMap((message) => (isJSONRPCRequest(message) ? [message.id] : []));
      if (transport && work && ids.length)
        res.once('close', () => {
          if (res.writableFinished || this.transports.get(sessionId as string) !== transport)
            return;
          for (const requestId of ids)
            if (calls.holds(work, requestId))
              transport.onmessage?.({
                jsonrpc: '2.0',
                method: 'notifications/cancelled',
                params: { requestId, reason: 'The HTTP request ended before its reply.' },
              });
        });
      await super.post(req, res);
    }

    override async open(res: GatewayResponse): Promise<StreamableHTTPServerTransport> {
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
        const session = await StatefulSession.open(
          this,
          res,
          logger,
          SESSION_IDLE_MS,
          (opened, responses) => {
            transport = opened;
            if (children.closing || ended) throw failure('Closed', 'The request ended.');
            this.openResponses.set(opened, responses);
            const owner = leasedOwner(children, release, localFailure, (stop) => {
              cleanup = stop;
            });
            let overloaded = false;
            return charged(startBackend(source, owner, logger), work, calls, () => {
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
        this.work.set(transport, work);
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
    }
  }

  // Session bookkeeping logs several info lines per request; they would push
  // useful entries out of the bounded Logs buffer. Keep its warnings and errors.
  const bookkeeping: GatewayLogger = {
    ...sessionLogger(log, () => true),
    info: () => {},
    debug: () => {},
  };
  return new LeasedSessions(source, children, bookkeeping, SESSION_IDLE_MS);
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

// Supergateway's processPeer and upstreamPeer, with the 4 MiB output bound
// applied before their otherwise unbounded readers.
const startBackend = (
  source: Source,
  children: ChildrenOwner,
  logger: GatewayLogger,
): PeerFactory => {
  if (source.stdioCmd) {
    const child = spawnCommand(spawn, source.stdioCmd, { ...children.spawnOptions, stdio: 'pipe' });
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
      child.stderr.on('data', (chunk) => owner.stderr(chunk.toString('utf8')));
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
    const fail = (error: Error) => owner.failure('upstream', error);
    // The upstream sees only its configured headers, never the client's token.
    const transport = new StreamableHTTPClientTransport(remote.url, {
      requestInit: { headers: remote.headers },
      fetch: async (url, init) =>
        readWhile(boundedBackendResponse(await fetch(url, init), fail), () => owner.output()),
    });
    const stop = children.track(async () => {
      // Bounded: an unresponsive upstream must not hold up the session's end.
      await Promise.race([
        transport
          .terminateSession()
          .catch((error) => logger.error('Session: failed to end the upstream session:', error)),
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
    transport.onerror = (error) => logger.error('Session: upstream error:', error);
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
