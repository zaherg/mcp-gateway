import { spawn } from "node:child_process";
import { constants } from "node:os";
import { isHttpServer } from "@mcp-gateway/core/config";
import { failure } from "@mcp-gateway/core/errors";
import {
  BACKEND_CAPACITY_ERROR,
  type BackendCalls,
  BackendOutputLimitError,
  boundedBackendResponse,
  MAX_BACKEND_MESSAGE_BYTES,
  type ResourceAdmission,
  type ResourceLease,
  readBackendLines,
  releaseAfterCleanup,
} from "@mcp-gateway/core/limits";
import { LogBuffer } from "@mcp-gateway/core/logs";
import { BackendProcesses } from "@mcp-gateway/core/process";
import { createSessions } from "@mcp-gateway/core/sessions";
import type { HttpServerConfig, LogLevel, StdioServerConfig } from "@mcp-gateway/shared/types";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import { createParser } from "eventsource-parser";
import express from "express";
import type {
  GatewayLogger,
  GatewayRequest,
  GatewayResponse,
  Source,
  StatefulMount,
  Upstream,
} from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import { spawnCommand } from "supergateway/dist/lib/childCommand.js";
import { getVersion } from "supergateway/dist/lib/getVersion.js";
import { HeaderMismatch } from "supergateway/dist/lib/headerMismatch.js";
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
import {
  MODERN_VERSION,
  SPEAKS_FOR_MS,
  UpstreamModernChild,
} from "supergateway/dist/lib/upstreamModernChild.js";

export type GatewayMount = StatefulMount;

const SHUTDOWN_MS = 8_000;

/** Session-based (pre-2026-07-28) MCP is served only by endpoints that opt in. */
const UNSUPPORTED_PROTOCOL_ERROR = {
  code: -32600,
  message: "Only MCP protocol version 2026-07-28 is supported.",
} as const;

/**
 * Normalizes SSE line endings across chunks.
 * A terminal CR is normalised immediately: the pinned parser otherwise defers it.
 */
const createLineFeed = (push: (text: string) => void): ((text: string) => void) => {
  let afterCR = false;
  return (text) => {
    if (!text) return;
    const normalized = afterCR && text.startsWith("\n") ? text.slice(1) : text;
    afterCR = text.endsWith("\r");
    push(normalized.replace(/\r\n?/g, "\n"));
  };
};

class CapacityError extends Error {}

// Pinned Supergateway 4.2.1 logs these at error level, but the client caused
// them: its own HTTP transport failed, or its headers did not mirror the body.
// They stay in Logs and never mark the backend as failed, as in sessions.ts.
const CLIENT_TRANSPORT_ERRORS = new Set([
  "Modern HTTP transport error:",
  "Modern HTTP adapter error:",
  "Failed to send MCP error:",
]);
const clientCaused = (args: readonly unknown[]): boolean =>
  (typeof args[0] === "string" && CLIENT_TRANSPORT_ERRORS.has(args[0])) ||
  args.some((value) => value instanceof HeaderMismatch);

// Only the owned close promise proves that backend work ended.
const cleanupConfirmed = (child: ModernChild): boolean => {
  return "cleanedUp" in child && child.cleanedUp === true;
};

type ModernSend = Parameters<PerRequestHTTPServerTransport["send"]>;

// A per-request transport that reports its terminal reply. Only a message for
// this request's own id ends its work; progress, unrelated late replies and
// server-originated messages do not.
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

// Coupled to Supergateway 4.2.1's exported modern primitives, not its CLI.
// Protocol dispatch, validation, opaque continuations and transports stay upstream.
// The command object takes childCommand.js's shell:false argument-array branch.
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
  const capture = (level: LogLevel, args: unknown[], diagnose = true) => {
    const stderr = typeof args[0] === "string" && args[0].startsWith("Child stderr:");
    logs.append({ server: name, level, source: stderr ? "stderr" : "logger" }, args);
    // Upstream HTTP transports also report a synthetic null/null "child" exit
    // on close. Preserve that log without replacing the actual HTTP failure.
    const upstreamClosed =
      isHttpServer(server) && args[0] === "Child exited: code=null, signal=null";
    if (
      diagnose &&
      !closing &&
      level === "error" &&
      !stderr &&
      !upstreamClosed &&
      !clientCaused(args)
    )
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
  const reserve = () => {
    if (children.closing) throw failure("Closed", "The backend is closing.");
    const lease = admission.acquire();
    if (!lease) throw new CapacityError();
    return lease;
  };

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
      exposedHeaders: [],
      healthEndpoints: [],
      apiKeys: [],
      logger,
    });
    const path = `/mcp/${name}`;
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
        })
      : undefined;
    if (sessions) {
      // A session's event stream (GET) and its end (DELETE).
      const request = handled(async (req, res) => {
        if (children.closing) {
          res.status(503).end();
          return;
        }
        await sessions.request(req, res);
      });
      app.get(path, request);
      app.delete(path, request);
    }
    app.post(
      path,
      handled(async (req, res) => {
        if (children.closing) {
          res.status(503).end();
          return;
        }
        const value = headerValue(req);
        const route = await admit(req, res, value, speaks);
        if (res.destroyed || res.writableEnded || children.closing) return;
        if (typeof route === "boolean") {
          // true: admission already answered. false: a session-protocol request.
          if (route) return;
          if (sessions) await sessions.post(req, res);
          else rejectWith(req, res, 400, UNSUPPORTED_PROTOCOL_ERROR);
          return;
        }
        // The pinned admission also routes envelope-bearing requests that claim an
        // older revision, or initialize with a modern envelope, to the backend.
        if (
          route.classification.revision !== MODERN_VERSION ||
          route.message.method === "initialize"
        ) {
          rejectWith(req, res, 400, UNSUPPORTED_PROTOCOL_ERROR);
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
      close: async () => {
        closing = true;
        await Promise.all([
          discovery?.close(),
          retained.close(),
          ...[...active].map((stop) => stop()),
          children.close(),
        ]);
      },
    };
  } catch (error) {
    diagnostic(error);
    throw failure("BackendFailure", "The backend mount could not be created.");
  }
};

const validExit = (code: string, signal: string): boolean => {
  return (
    (code === "null" || (Number(code) >= -1 && Number(code) <= 255)) &&
    (signal === "null" || Object.hasOwn(constants.signals, signal))
  );
};

/** Only allowlisted codes and numeric statuses may enter status summaries. */
export const backendSummary = (args: readonly unknown[]): string => {
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
};

// Deadlines bound each wait, not ownership of the underlying cleanup. A raw
// rejection is unconfirmed cleanup and must remain a failure on every retry.
const mountClosures = new WeakMap<StatefulMount, Promise<void>>();

export const closeMount = async (
  mount: StatefulMount,
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
};
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_ID = "supergateway-discover";

const discoveryResult = (data: string): boolean | undefined => {
  const message = JSONRPCMessageSchema.parse(JSON.parse(data));
  if (!("id" in message) || "method" in message || message.id !== DISCOVERY_ID) return undefined;
  if (!("result" in message)) return false;
  const versions = message.result.supportedVersions;
  return (
    Array.isArray(versions) &&
    versions.every((version) => typeof version === "string") &&
    versions.includes(MODERN_VERSION)
  );
};

/** Pinned Supergateway capability check with explicit cancellation and bounded input.
 * Its original remoteSpeaksModern helper provides neither a signal nor a close hook.
 */
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
          method: "POST",
          signal: AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
          ]),
          headers: {
            ...this.upstream.headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MODERN_VERSION,
            "mcp-method": "server/discover",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: DISCOVERY_ID,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientInfo": {
                  name: "supergateway",
                  version: getVersion(),
                },
                "io.modelcontextprotocol/clientCapabilities": {},
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
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let result: boolean | undefined;
      const parser = response.headers.get("content-type")?.includes("text/event-stream")
        ? createParser({
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
          const { value, done } = await reader.read();
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
          await reader.cancel();
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
