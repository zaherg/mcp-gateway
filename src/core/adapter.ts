import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CancelledNotificationSchema,
  isJSONRPCRequest,
  JSONRPCErrorResponseSchema,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  JSONRPCResultResponseSchema,
} from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import { createParser } from "eventsource-parser";
import express from "express";
import { StatefulSession } from "supergateway/dist/gateways/statefulSession.js";
import { StatefulSessions } from "supergateway/dist/gateways/statefulSessions.js";
import type {
  ChildrenOwner,
  GatewayLogger,
  GatewayRequest,
  GatewayResponse,
  Peer,
  PeerFactory,
  PeerOwner,
  Source,
  StatefulMount,
} from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import { spawnCommand } from "supergateway/dist/lib/childCommand.js";
import {
  admit,
  headerValue,
  paramHeaders,
  rejectWith,
} from "supergateway/dist/lib/modernAdmission.js";
import { ModernRequest } from "supergateway/dist/lib/modernRequest.js";
import { PerRequestHTTPServerTransport } from "supergateway/dist/lib/modernSdk.js";
import { OwnedStdioTransport } from "supergateway/dist/lib/ownedStdioTransport.js";
import {
  CONTINUATION_TIMEOUT,
  isContinuationHandle,
  type ModernChild,
  RETAINED_CHILD_LIMIT,
  RetainedChildren,
  type ReusedChild,
} from "supergateway/dist/lib/retainedChildren.js";
import { streamableHttpApp } from "supergateway/dist/lib/streamableHttpApp.js";
import { UpstreamModernChild } from "supergateway/dist/lib/upstreamModernChild.js";
import type { LogLevel } from "../shared/logs";
import type { HttpServerConfig, StdioServerConfig } from "../shared/types";
import {
  BackendOutputLimitError,
  boundedBackendResponse,
  MAX_BACKEND_MESSAGE_BYTES,
  readBackendLines,
} from "./backend-output";
import { startBackend } from "./backend-peer";
import { BackendProcesses } from "./backend-processes";
import {
  BACKEND_CAPACITY_ERROR,
  BACKEND_ID_EXHAUSTED_ERROR,
  type BackendCalls,
  BackendWireIds,
  DUPLICATE_REQUEST_ERROR,
  MAX_BACKEND_CALLS,
  releaseAfterCleanup,
  type WorkOwner,
} from "./backend-work";
import { isHttpServer } from "./config";
import { UpstreamDiscovery } from "./discovery";
import { failure } from "./errors";
import { installLegacyCancellation } from "./legacy-cancellation";
import { LogBuffer } from "./logs";
import { requestMessages } from "./request-body";
import type { ResourceAdmission, ResourceLease } from "./resource-admission";

export interface GatewayMount extends StatefulMount {
  claimControl(
    req: GatewayRequest,
    messages: readonly JSONRPCMessage[] | undefined,
  ): (() => void) | undefined;
}

export const SESSION_IDLE_MS = 60_000;

// Tracks server-originated request ids per legacy session so that client
// replies admitted as control traffic are provably answering an outstanding
// request the gateway forwarded. The WeakMap is keyed by the session transport
// object owned by Supergateway; entries are discarded with the transport.
const serverRequestIds = new WeakMap<StreamableHTTPServerTransport, Set<string | number>>();
export const SHUTDOWN_MS = 8_000;

class CapacityError extends Error {}

// A fixed, payload-free local diagnostic for a legacy backend line that parsed
// as JSON but is not a valid terminal response envelope.
const MALFORMED_LEGACY_RESPONSE = "Legacy backend response envelope was malformed.";
const DUPLICATE_DROPPED = "Duplicate in-flight legacy request was dropped.";

// Lease release requires confirmed process-group absence or upstream session cleanup.
function leasedOwner(
  children: BackendProcesses,
  lease: ResourceLease,
  reportFailure: (error: unknown) => void,
  confirm?: () => void,
): ChildrenOwner {
  const track = (stop: () => Promise<void>) =>
    children.track(() =>
      releaseAfterCleanup(stop(), () => {
        lease.release();
        confirm?.();
      }),
    );
  return {
    get closing() {
      return children.closing;
    },
    spawnOptions: children.spawnOptions,
    own: (child) => {
      const stop = track(children.own(child));
      child.once("exit", () => {
        void stop().catch(reportFailure);
      });
      return stop;
    },
    track,
  };
}

// A session's validated client messages reach the backend exactly here, after
// the session transport has accepted them. Client ids are not forwarded: each
// admitted request gets the next backend-facing wire id, so a late reply for a
// cancelled or reused client id cannot match newer work. Only active mappings
// are retained and wire ids are never reused within this peer. Server-originated
// requests, client responses to them, progress tokens and payload data pass
// through untouched.
function admitPeer(
  factory: PeerFactory,
  owner: PeerOwner,
  work: WorkOwner,
  wires: BackendWireIds,
  calls: BackendCalls,
  localFailure: (error: unknown) => void,
  cancelled: (id: string | number) => void,
): Peer {
  // A refusal answers a request the session already recorded in
  // pendingRequests/progressOf. Delivering the error through the inherited
  // owner.message settlement path clears that bookkeeping; a raw transport.send
  // leaks retained IDs and breaks later server-originated routing.
  const refuse = (id: string | number, error: { code: number; message: string }) => {
    const response = { jsonrpc: "2.0" as const, id, error };
    owner.message(response, JSON.stringify(response));
  };
  const peer = factory({
    ...owner,
    message: (message, line) => {
      const raw: unknown = message;
      if (typeof raw !== "object" || raw === null) {
        localFailure(MALFORMED_LEGACY_RESPONSE);
        return;
      }
      if ("method" in message) {
        if (!JSONRPCMessageSchema.safeParse(raw).success) {
          localFailure(MALFORMED_LEGACY_RESPONSE);
          return;
        }
        owner.message(message, line);
        return;
      }
      const valid =
        JSONRPCResultResponseSchema.safeParse(raw).success ||
        JSONRPCErrorResponseSchema.safeParse(raw).success;
      if (!valid) {
        // Not a terminal response: keep its wire mapping and work reservation.
        localFailure(MALFORMED_LEGACY_RESPONSE);
        return;
      }
      if (!("id" in raw) || typeof raw.id !== "number") return;
      const original = wires.take(raw.id);
      // A valid late or otherwise unmapped reply is not delivered.
      if (original === undefined) return;
      calls.settle(work, original);
      const translated = { ...raw, id: original };
      owner.message(translated as JSONRPCMessage, JSON.stringify(translated));
    },
  });
  return {
    write: (message) => {
      if (!("method" in message)) {
        peer.write(message);
        return;
      }
      const id = "id" in message ? message.id : undefined;
      if (typeof id === "string" || typeof id === "number") {
        if (wires.holds(id)) {
          // The pre-transport gate refuses duplicates. If one still reaches this
          // peer, drop it without settling the original request's bookkeeping.
          localFailure(DUPLICATE_DROPPED);
          return;
        }
        if (!calls.admit(work, id)) {
          refuse(id, BACKEND_CAPACITY_ERROR);
          return;
        }
        const wire = wires.register(id);
        if (wire === undefined) {
          calls.settle(work, id);
          refuse(id, BACKEND_ID_EXHAUSTED_ERROR);
          return;
        }
        try {
          peer.write({ ...message, id: wire });
        } catch (error) {
          wires.release(id);
          calls.settle(work, id);
          throw error;
        }
        return;
      }
      if (message.method === "notifications/cancelled") {
        const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          const wire = wires.wireOf(requestId);
          // An id this peer never forwarded has nothing to cancel; forwarding it
          // unchanged could cancel a different wire id.
          if (wire === undefined) return;
          try {
            peer.write({ ...message, params: { ...message.params, requestId: wire } });
          } catch (error) {
            // A failed forward keeps its mapping and work charged for cleanup.
            localFailure(error);
            return;
          }
          cancelled(requestId);
          wires.release(requestId);
          calls.settle(work, requestId);
          return;
        }
      }
      peer.write(message);
    },
    end: () => peer.end(),
    stop: () => peer.stop(),
    get gone() {
      return peer.gone;
    },
  };
}

// A complete single or legacy batch body, using the installed SDK schema.
// Undefined means malformed: the inherited SDK path owns that error response.
function legacyMessages(body: unknown): JSONRPCMessage[] | undefined {
  const items = Array.isArray(body) ? body : [body];
  const messages: JSONRPCMessage[] = [];
  for (const item of items) {
    const parsed = JSONRPCMessageSchema.safeParse(item);
    if (!parsed.success) return undefined;
    messages.push(parsed.data);
  }
  return messages;
}

// Only requests consume in-dispatch claims; notifications and client responses
// to server-originated requests do not.
function legacyRequestIds(messages: readonly JSONRPCMessage[]): (string | number)[] {
  return messages.filter(isJSONRPCRequest).map((message) => message.id);
}

// Only the owned close promise proves that backend work ended.
function cleanupConfirmed(child: ModernChild): boolean {
  return "cleanedUp" in child && child.cleanedUp === true;
}

type ModernSend = Parameters<PerRequestHTTPServerTransport["send"]>;

// A per-request modern transport that reports its terminal reply. Only a
// message for this request's own id ends its work; progress, unrelated late
// replies and server-originated messages do not.
class WorkTransport extends PerRequestHTTPServerTransport {
  private readonly replied: (message: ModernSend[0]) => void;
  constructor(
    options: ConstructorParameters<typeof PerRequestHTTPServerTransport>[0],
    replied: (message: ModernSend[0]) => void,
  ) {
    super(options);
    this.replied = replied;
  }
  override async send(message: ModernSend[0], options?: ModernSend[1]): Promise<void> {
    if (!("method" in message) && "id" in message) this.replied(message);
    await super.send(message, options);
  }
}

// Coupled to Supergateway 4.2.1's exported lifecycle primitives, not its CLI.
// Protocol dispatch, validation, opaque continuations and transports stay upstream.
// The command object takes childCommand.js's shell:false argument-array branch.
export function createMount(
  name: string,
  server: StdioServerConfig | HttpServerConfig,
  onDiagnostic: (summary: string) => void,
  admission: ResourceAdmission,
  calls: BackendCalls,
  logs = new LogBuffer(),
): GatewayMount {
  const reservedControls = new WeakSet<GatewayRequest>();
  const controlClaims = new WeakMap<StreamableHTTPServerTransport, Set<string>>();
  const discard = (..._args: unknown[]) => {};
  let closing = false;
  const capture = (level: LogLevel, args: unknown[], expectedExit = false) => {
    const stderr = typeof args[0] === "string" && args[0].startsWith("Child stderr:");
    logs.append({ server: name, level, source: stderr ? "stderr" : "logger" }, args);
    // Upstream HTTP transports also report a synthetic null/null "child" exit
    // on close. Preserve that log without replacing the actual HTTP failure.
    const upstreamClosed =
      isHttpServer(server) && args[0] === "Child exited: code=null, signal=null";
    if (!closing && !expectedExit && level === "error" && !stderr && !upstreamClosed)
      onDiagnostic(backendSummary(args));
  };
  const diagnostic = (...args: unknown[]) => capture("error", args);
  const logger: GatewayLogger = {
    info: (...args) => capture("info", args),
    error: diagnostic,
    debug: (...args) => capture("debug", args),
    warn: (...args) => capture("warn", args),
  };
  const source: Source = isHttpServer(server)
    ? { upstream: { type: "streamableHttp", url: new URL(server.url), headers: server.headers } }
    : {
        stdioCmd: {
          command: server.command,
          args: server.args ?? [],
          env: server.env,
          cwd: server.cwd,
        },
      };
  const children = new BackendProcesses(logger);
  // Local send failures are not backend diagnostics; keep them out of the
  // backend status while retaining the observation in app-local Logs.
  const localFailure = (error: unknown) =>
    logs.append({ server: name, level: "error", source: "logger" }, [error]);
  const reserve = () => {
    if (children.closing) throw failure("Closed", "The backend is closing.");
    const lease = admission.acquire();
    if (!lease) throw new CapacityError();
    return lease;
  };

  class LeasedSessions extends StatefulSessions {
    private readonly sessionWires = new WeakMap<StreamableHTTPServerTransport, BackendWireIds>();
    private readonly dispatching = new WeakMap<
      StreamableHTTPServerTransport,
      Set<string | number>
    >();

    wireIdsOf(transport: StreamableHTTPServerTransport): BackendWireIds | undefined {
      return this.sessionWires.get(transport);
    }

    /** In-dispatch request ids, claimed synchronously before inherited post(). */
    claimsFor(transport: StreamableHTTPServerTransport): Set<string | number> {
      let claims = this.dispatching.get(transport);
      if (!claims) {
        claims = new Set();
        this.dispatching.set(transport, claims);
      }
      return claims;
    }

    override async open(res: GatewayResponse): Promise<StreamableHTTPServerTransport> {
      const lease = reserve();
      let transport: StreamableHTTPServerTransport | undefined;
      let transportClosed = false;
      const sessionLogger: GatewayLogger = {
        ...logger,
        error: (...args) =>
          capture(
            "error",
            args,
            transportClosed &&
              typeof args[0] === "string" &&
              args[0].startsWith("Child exited: code="),
          ),
      };
      let ended = false;
      let cleanup: (() => Promise<void>) | undefined;
      let settleCancelled = (_id: string | number): void => {
        throw new Error("Legacy session is not initialized.");
      };
      const end = () => {
        ended = true;
        // A rejected/abandoned initialize must close only its own transport.
        if (transport && (!res.writableFinished || res.statusCode >= 400 || !transport.sessionId))
          void transport.close().catch(diagnostic);
      };
      res.once("finish", end);
      res.once("close", end);
      const work = calls.owner();
      const wires = new BackendWireIds();
      const owner = leasedOwner(children, lease, localFailure, () => {
        calls.settleOwner(work);
        wires.clear();
      });
      try {
        const session = await StatefulSession.open(
          this,
          res,
          sessionLogger,
          SESSION_IDLE_MS,
          (opened, responses) => {
            transport = opened;
            if (children.closing || ended) throw failure("Closed", "The request ended.");
            this.openResponses.set(opened, responses);
            this.sessionWires.set(opened, wires);
            const factory = startBackend(
              source,
              {
                ...owner,
                own: (child) => (cleanup = owner.own(child)),
                track: (stop) => (cleanup = owner.track(stop)),
              },
              sessionLogger,
            );
            return (peerOwner) =>
              admitPeer(factory, peerOwner, work, wires, calls, localFailure, (id) =>
                settleCancelled(id),
              );
          },
        );
        transport = session.transport;
        const reverseIds = new Set<string | number>();
        serverRequestIds.set(transport, reverseIds);
        const send = transport.send.bind(transport);
        transport.send = async (message, options) => {
          if (!isJSONRPCRequest(message)) return send(message, options);
          if (reverseIds.has(message.id) || reverseIds.size >= MAX_BACKEND_CALLS)
            throw failure("BackendFailure", "Too many pending server requests.");
          reverseIds.add(message.id);
          try {
            await send(message, options);
          } catch (error) {
            reverseIds.delete(message.id);
            throw error;
          }
        };
        const receive = transport.onmessage;
        transport.onmessage = (message, extra) => {
          receive?.(message, extra);
          if (
            !("method" in message) &&
            (typeof message.id === "string" || typeof message.id === "number")
          )
            reverseIds.delete(message.id);
        };
        const cancel = installLegacyCancellation(session);
        settleCancelled = (id) => {
          cancel(id);
          this.claimsFor(session.transport).delete(id);
        };
        const onclose = transport.onclose;
        transport.onclose = () => {
          // Mark before the session stops its child, not during exit-triggered owner cleanup.
          transportClosed = true;
          reverseIds.clear();
          onclose?.();
        };
        if (ended) end();
        return transport;
      } catch (error) {
        res.off("finish", end);
        res.off("close", end);
        await transport?.close();
        if (cleanup) await cleanup();
        else lease.release();
        throw error;
      }
    }
  }

  // The pinned stdio start() spawns synchronously, before its Promise settles.
  // Both wrappers keep the lease through retention and idempotent actual close.
  class LeasedStdio extends OwnedStdioTransport {
    override close: () => Promise<void>;
    cleanedUp = false;

    override async start(): Promise<void> {
      if (!source.stdioCmd) throw new Error("Expected stdio source");
      const child = spawnCommand(spawn, source.stdioCmd, {
        ...children.spawnOptions,
        stdio: "pipe",
      });
      this.child = child;
      this.stop = children.own(child);
      this.watch(child);
      child.stderr.on("data", (chunk) => logger.error("Child stderr:", chunk.toString("utf8")));
      readBackendLines(
        child.stdout,
        (line) => this.deliver(line),
        (error) => {
          child.stdout.destroy(error);
        },
        () => undefined,
      );
    }

    constructor(lease: ResourceLease) {
      if (!source.stdioCmd) throw new Error("Expected stdio source");
      super(source.stdioCmd, children, logger);
      this.close = children.track(() =>
        releaseAfterCleanup(super.close(), () => {
          lease.release();
          this.cleanedUp = true;
        }),
      );
    }
  }
  class LeasedUpstream extends UpstreamModernChild {
    private readonly sending = new Set<Promise<void>>();
    override close: () => Promise<void>;
    cleanedUp = false;

    override async send(message: Parameters<ModernChild["send"]>[0]): Promise<void> {
      const pending = super.send(message);
      this.sending.add(pending);
      try {
        await pending;
      } finally {
        this.sending.delete(pending);
      }
    }

    override read(response: Response, awaited?: string | number): Promise<void> {
      return super.read(boundedBackendResponse(response), awaited);
    }

    override async events(response: Response, deliver: (value: unknown) => void): Promise<void> {
      if (!response.body) throw new Error("Upstream event stream has no body");
      const parser = createParser({
        maxBufferSize: MAX_BACKEND_MESSAGE_BYTES,
        onError: (error) => {
          if (error.type === "max-buffer-size-exceeded") throw new BackendOutputLimitError();
        },
        onEvent: ({ data }) => {
          if (Buffer.byteLength(data) > MAX_BACKEND_MESSAGE_BYTES)
            throw new BackendOutputLimitError();
          if (data) deliver(JSON.parse(data));
        },
      });
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let afterCR = false;
      const feed = (text: string) => {
        if (!text) return;
        // Normalize immediately: the pinned parser otherwise defers a terminal CR.
        const normalized = afterCR && text.startsWith("\n") ? text.slice(1) : text;
        afterCR = text.endsWith("\r");
        parser.feed(normalized.replace(/\r\n?/g, "\n"));
      };
      for await (const chunk of response.body) {
        feed(decoder.decode(chunk, { stream: true }));
        await this.held;
      }
      feed(decoder.decode());
      // Do not flush incomplete events; read() requires a fully framed reply.
    }

    constructor(
      lease: ResourceLease,
      declared: { version: string | undefined; params: Record<string, string> },
    ) {
      if (!source.upstream) throw new Error("Expected upstream source");
      super(source.upstream, declared, logger);
      this.close = children.track(() =>
        releaseAfterCleanup(
          (async () => {
            await super.close();
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

  try {
    const app = streamableHttpApp(express, cors, {
      headers: {},
      exposedHeaders: ["Mcp-Session-Id"],
      healthEndpoints: [],
      apiKeys: [],
      logger,
    });
    const path = `/mcp/${name}`;
    const sessions = new LeasedSessions(source, children, logger, SESSION_IDLE_MS);
    const discovery = source.upstream ? new UpstreamDiscovery(source.upstream) : undefined;
    const speaks = discovery?.speaks ?? (() => true);
    const active = new Set<() => Promise<void>>();
    const retained = new RetainedChildren({
      idleMs: CONTINUATION_TIMEOUT,
      limit: RETAINED_CHILD_LIMIT,
      logger,
    });
    const handled =
      (handle: (req: GatewayRequest, res: GatewayResponse) => Promise<void>) =>
      (req: GatewayRequest, res: GatewayResponse, next: (error?: unknown) => void) => {
        void handle(req, res).catch(next);
      };
    app.post(
      path,
      handled(async (req, res) => {
        if (children.closing) {
          res.status(503).end();
          return;
        }
        // A reserved request already owns an existing legacy control operation.
        // It must never enter modern discovery or create a per-request backend.
        if (reservedControls.has(req)) {
          await sessions.post(req, res);
          return;
        }
        const value = headerValue(req);
        const route = await admit(req, res, value, speaks);
        if (res.destroyed || res.writableEnded || children.closing) return;
        if (typeof route === "boolean") {
          if (!route) {
            const sessionId = req.headers["mcp-session-id"];
            const session =
              typeof sessionId === "string" ? sessions.transports.get(sessionId) : undefined;
            const sessionWires = session ? sessions.wireIdsOf(session) : undefined;
            if (session && sessionWires) {
              const messages = requestMessages(req) ?? legacyMessages(req.body);
              const ids = messages ? legacyRequestIds(messages) : undefined;
              if (ids) {
                // All checks and claims are synchronous: no await sits between
                // them, so concurrent POSTs and batches cannot both pass.
                const claims = sessions.claimsFor(session);
                const unique = new Set(ids);
                const collision =
                  unique.size !== ids.length ||
                  ids.some((id) => sessionWires.holds(id) || claims.has(id));
                if (collision) {
                  rejectWith(req, res, 400, DUPLICATE_REQUEST_ERROR);
                  return;
                }
                for (const id of ids) claims.add(id);
                try {
                  await sessions.post(req, res);
                } finally {
                  for (const id of ids) claims.delete(id);
                }
                return;
              }
            }
            // Unknown sessions, initialization and malformed bodies keep the
            // inherited SDK validation and error paths.
            await sessions.post(req, res);
          }
          return;
        }
        const requestId = route.messageKind === "request" ? route.message.id : undefined;
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
          const transport = new WorkTransport(
            { classification: route.classification },
            (message) => {
              const id = "id" in message ? message.id : undefined;
              if (
                requestId !== undefined &&
                (typeof id === "string" || typeof id === "number") &&
                id === requestId
              )
                releaseWork();
            },
          );
          const continuation =
            route.messageKind === "request" ? route.message.params?.requestState : undefined;
          let reused: ReusedChild | undefined;
          if (isContinuationHandle(continuation)) {
            const waiting = new AbortController();
            const abort = () => waiting.abort();
            res.once("close", abort);
            try {
              reused = await retained.take(continuation, waiting.signal);
            } finally {
              res.off("close", abort);
            }
            if (!reused) {
              await transport.close();
              if (!res.destroyed) {
                rejectWith(req, res, 400, {
                  code: -32602,
                  message: "Continuation expired or backend unavailable",
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
                    version: value("mcp-protocol-version"),
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
          // A terminal reply already ended this work. Without one, only the
          // owned child's confirmed cleanup frees its slot.
          if (child && cleanupConfirmed(child)) releaseWork();
        } finally {
          // Refusals before a child exists cannot have dispatched backend work.
          if (!child) releaseWork();
        }
      }),
    );
    app.get(
      path,
      handled((req, res) => sessions.request(req, res)),
    );
    app.delete(
      path,
      handled((req, res) => sessions.request(req, res)),
    );
    // Express's default handler exposes stack traces and raw backend errors.
    app.use((error, _req, res, _next) => {
      if (error instanceof CapacityError) res.status(429).end();
      else {
        diagnostic(error);
        if (res.headersSent) res.destroy();
        else res.status(502).end();
      }
    });
    return {
      app,
      path,
      listening: discard,
      close: async () => {
        closing = true;
        await Promise.all([
          discovery?.close(),
          retained.close(),
          ...[...active].map((stop) => stop()),
          children.close(),
        ]);
      },
      claimControl: (req, messages) => {
        const sessionId = req.headers["mcp-session-id"];
        if (
          children.closing ||
          typeof sessionId !== "string" ||
          req.headers["mcp-protocol-version"] === "2026-07-28"
        )
          return undefined;
        const session = sessions.transports.get(sessionId);
        if (!session) return undefined;
        const keys: string[] = [];
        if (req.method === "DELETE") keys.push("delete");
        else if (req.method === "POST" && messages?.length) {
          const wires = sessions.wireIdsOf(session);
          const pending = serverRequestIds.get(session);
          for (const message of messages) {
            if ("method" in message) {
              if ("id" in message) return undefined;
              const parsed = CancelledNotificationSchema.safeParse(message);
              if (!parsed.success) return undefined;
              const id = parsed.data.params.requestId;
              if ((typeof id !== "string" && typeof id !== "number") || !wires?.holds(id))
                return undefined;
              keys.push(JSON.stringify(["cancel", id]));
            } else {
              if (
                (typeof message.id !== "string" && typeof message.id !== "number") ||
                !pending?.has(message.id)
              )
                return undefined;
              keys.push(JSON.stringify(["reply", message.id]));
            }
          }
        } else return undefined;
        const claims = controlClaims.get(session) ?? new Set<string>();
        if (
          claims.has("delete") ||
          (req.method === "DELETE" && claims.size) ||
          new Set(keys).size !== keys.length ||
          keys.some((key) => claims.has(key))
        )
          return undefined;
        controlClaims.set(session, claims);
        for (const key of keys) claims.add(key);
        reservedControls.add(req);
        return () => {
          for (const key of keys) claims.delete(key);
          reservedControls.delete(req);
        };
      },
    };
  } catch (error) {
    diagnostic(error);
    throw failure("BackendFailure", "The backend mount could not be created.");
  }
}

function validExit(code: string, signal: string): boolean {
  return (
    (code === "null" || (Number(code) >= -1 && Number(code) <= 255)) &&
    (signal === "null" || Object.hasOwn(constants.signals, signal))
  );
}

/** Only allowlisted codes and numeric statuses may enter status summaries. */
export function backendSummary(args: readonly unknown[]): string {
  const codes = new Set([
    "ENOENT",
    "EACCES",
    "EPERM",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EADDRINUSE",
    "ENOTFOUND",
  ]);
  const pending = [...args];
  const seen = new Set<object>();
  for (let index = 0; index < Math.min(pending.length, 16); index++) {
    const value = pending[index];
    if (value && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      try {
        const cause = Object.getOwnPropertyDescriptor(value, "cause")?.value;
        if (cause) pending.push(cause);
        const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
        if (typeof code === "string" && codes.has(code))
          return `Backend failed (${code}). Check the executable, permissions or connection. Open Logs for details.`;
        const status =
          Object.getOwnPropertyDescriptor(value, "status")?.value ??
          (typeof code === "number" ? code : undefined);
        if (Number.isInteger(status) && status >= 400 && status <= 599)
          return `Backend HTTP request failed (${status}). Open Logs for details.`;
        const message = Object.getOwnPropertyDescriptor(value, "message")?.value;
        if (typeof message === "string") {
          const remote = /^The remote server answered ([45]\d{2})$/.exec(message);
          if (remote) return `Backend HTTP request failed (${remote[1]}). Open Logs for details.`;
          const http = /^Streamable HTTP error: Error POSTing to endpoint: ([45]\d{2})\b/.exec(
            message,
          );
          if (http) return `Backend HTTP request failed (${http[1]}). Open Logs for details.`;
          const exit = /^Child exited: code=(-?\d+|null), signal=(SIG[A-Z0-9]+|null)$/.exec(
            message,
          );
          if (exit && validExit(exit[1], exit[2]))
            return `Backend process exited (code ${exit[1]}, signal ${exit[2]}). Open Logs for details.`;
        }
      } catch {
        /* Unreadable diagnostics still remain a generic failure. */
      }
    }
    if (typeof value === "string") {
      const exit = /^Child exited: code=(-?\d+|null), signal=(SIG[A-Z0-9]+|null)$/.exec(value);
      if (exit && validExit(exit[1], exit[2]))
        return `Backend process exited (code ${exit[1]}, signal ${exit[2]}). Open Logs for details.`;
    }
  }
  return "A backend operation failed. Open Logs for details.";
}

// Deadlines bound each wait, not ownership of the underlying cleanup. A raw
// rejection is unconfirmed cleanup and must remain a failure on every retry.
const mountClosures = new WeakMap<StatefulMount, Promise<void>>();

export async function closeMount(
  mount: StatefulMount,
  onFailure?: (error: unknown) => void,
): Promise<void> {
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
          () => reject(failure("ShutdownFailure", "Backend cleanup exceeded its deadline.")),
          SHUTDOWN_MS,
        );
      }),
    ]);
  } catch (error) {
    onFailure?.(error);
    throw failure("ShutdownFailure", "Backend cleanup did not complete successfully.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
