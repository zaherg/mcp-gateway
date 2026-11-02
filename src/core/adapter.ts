import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import { StatefulSession } from "supergateway/dist/gateways/statefulSession.js";
import { StatefulSessions } from "supergateway/dist/gateways/statefulSessions.js";
import type {
  ChildrenOwner,
  GatewayLogger,
  GatewayRequest,
  GatewayResponse,
  Source,
  StatefulMount,
} from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import {
  admit,
  headerValue,
  paramHeaders,
  rejectWith,
} from "supergateway/dist/lib/modernAdmission.js";
import { ModernRequest } from "supergateway/dist/lib/modernRequest.js";
import { PerRequestHTTPServerTransport } from "supergateway/dist/lib/modernSdk.js";
import { OwnedChildProcesses } from "supergateway/dist/lib/ownedChildProcesses.js";
import { OwnedStdioTransport } from "supergateway/dist/lib/ownedStdioTransport.js";
import {
  CONTINUATION_TIMEOUT,
  isContinuationHandle,
  type ModernChild,
  RETAINED_CHILD_LIMIT,
  RetainedChildren,
  type ReusedChild,
} from "supergateway/dist/lib/retainedChildren.js";
import { startServer } from "supergateway/dist/lib/serverSource.js";
import { streamableHttpApp } from "supergateway/dist/lib/streamableHttpApp.js";
import { UpstreamModernChild } from "supergateway/dist/lib/upstreamModernChild.js";
import type { LogLevel } from "../shared/logs";
import type { HttpServerConfig, StdioServerConfig } from "../shared/types";
import { isHttpServer } from "./config";
import { UpstreamDiscovery } from "./discovery";
import { failure } from "./errors";
import { LogBuffer } from "./logs";
import type { ResourceAdmission, ResourceLease } from "./resource-admission";

export const SESSION_IDLE_MS = 60_000;
export const SHUTDOWN_MS = 8_000;

class CapacityError extends Error {}

// Unlike an HTTP response, these ownership callbacks settle after Supergateway's
// process-group termination or upstream session cleanup. Keep failed cleanup charged.
function leasedOwner(children: OwnedChildProcesses, lease: ResourceLease): ChildrenOwner {
  const track = (stop: () => Promise<void>) =>
    children.track(async () => {
      await stop();
      lease.release();
    });
  return {
    get closing() {
      return children.closing;
    },
    spawnOptions: children.spawnOptions,
    own: (child) => {
      const stop = track(children.own(child));
      child.once("exit", () => void stop());
      return stop;
    },
    track,
  };
}

// Coupled to Supergateway 4.2.1's exported lifecycle primitives, not its CLI.
// Protocol dispatch, validation, opaque continuations and transports stay upstream.
// The command object takes childCommand.js's shell:false argument-array branch.
export function createMount(
  name: string,
  server: StdioServerConfig | HttpServerConfig,
  onDiagnostic: (summary: string) => void,
  admission: ResourceAdmission,
  logs = new LogBuffer(),
): StatefulMount {
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
  const children = new OwnedChildProcesses(logger);
  const reserve = () => {
    if (children.closing) throw failure("Closed", "The backend is closing.");
    const lease = admission.acquire();
    if (!lease) throw new CapacityError();
    return lease;
  };

  class LeasedSessions extends StatefulSessions {
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
      const end = () => {
        ended = true;
        // A rejected/abandoned initialize must close only its own transport.
        if (transport && (!res.writableFinished || res.statusCode >= 400 || !transport.sessionId))
          void transport.close().catch(diagnostic);
      };
      res.once("finish", end);
      res.once("close", end);
      const owner = leasedOwner(children, lease);
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
            return startServer(
              spawn,
              source,
              {
                ...owner,
                own: (child) => (cleanup = owner.own(child)),
                track: (stop) => (cleanup = owner.track(stop)),
              },
              sessionLogger,
              "Session",
            );
          },
        );
        transport = session.transport;
        const onclose = transport.onclose;
        transport.onclose = () => {
          // Mark before the session stops its child, not during exit-triggered owner cleanup.
          transportClosed = true;
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
    constructor(lease: ResourceLease) {
      if (!source.stdioCmd) throw new Error("Expected stdio source");
      super(source.stdioCmd, children, logger);
      this.close = children.track(async () => {
        await super.close();
        lease.release();
      });
    }
  }
  class LeasedUpstream extends UpstreamModernChild {
    private readonly sending = new Set<Promise<void>>();
    override close: () => Promise<void>;

    override async send(message: Parameters<ModernChild["send"]>[0]): Promise<void> {
      const pending = super.send(message);
      this.sending.add(pending);
      try {
        await pending;
      } finally {
        this.sending.delete(pending);
      }
    }

    constructor(
      lease: ResourceLease,
      declared: { version: string | undefined; params: Record<string, string> },
    ) {
      if (!source.upstream) throw new Error("Expected upstream source");
      super(source.upstream, declared, logger);
      this.close = children.track(async () => {
        await super.close();
        // Abort alone does not settle pending fetches or body readers.
        await Promise.allSettled(this.sending);
        await Promise.allSettled(this.reading);
        lease.release();
      });
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
        const value = headerValue(req);
        const route = await admit(req, res, value, speaks);
        if (res.destroyed || res.writableEnded || children.closing) return;
        if (typeof route === "boolean") {
          if (!route) await sessions.post(req, res);
          return;
        }
        const transport = new PerRequestHTTPServerTransport({
          classification: route.classification,
        });
        const continuation =
          route.messageKind === "request" ? route.message.params?.requestState : undefined;
        let reused: ReusedChild | undefined;
        if (isContinuationHandle(continuation)) {
          const waiting = new AbortController();
          const cancel = () => waiting.abort();
          res.once("close", cancel);
          if (res.destroyed) cancel();
          try {
            reused = await retained.take(continuation, waiting.signal);
          } finally {
            res.off("close", cancel);
          }
          if (!reused) {
            await transport.close();
            if (!res.destroyed)
              rejectWith(req, res, 400, {
                code: -32602,
                message: "Continuation expired or backend unavailable",
              });
            return;
          }
        }
        let child = reused?.child;
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
