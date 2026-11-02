import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { StatefulMount } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import type { GatewayConfig, InterfaceChoice, ServerSnapshot, VisibleError } from "../shared/types";
import { backendSummary, closeMount, createMount } from "./adapter";
import { BackendCalls, MAX_BACKEND_CALLS } from "./backend-work";
import { isHttpServer, serverFingerprint } from "./config";
import { failure, visible } from "./errors";
import { LogBuffer } from "./logs";
import { peerAllowed, rejectSelfProxy, type SelfProxyOptions, selectInterface } from "./network";
import { ResourceAdmission } from "./resource-admission";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 32;
export const MAX_SESSIONS = 16;
export const REQUEST_DEADLINE_MS = 30_000;
const MAX_CONNECTIONS = 64;
const MAX_REQUESTS_PER_MINUTE = 240;
interface Endpoint {
  mount: StatefulMount;
  fingerprint: string;
  responses: Set<ServerResponse>;
}
const digest = (text: string) => createHash("sha256").update(text).digest();

export class GatewayIngress {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly backendErrors = new Map<string, VisibleError>();
  private readonly closingMounts = new Map<string, StatefulMount>();
  private readonly admission = new ResourceAdmission(MAX_SESSIONS);
  // One backend-work budget shared by every endpoint and session.
  private readonly work = new BackendCalls(MAX_BACKEND_CALLS);
  private selected: InterfaceChoice;
  private activeRequests = 0;
  private rateStart = Date.now();
  private rateCount = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private listenerStopped: Promise<void> | undefined;
  private monitor: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private config: GatewayConfig,
    private readonly report: (error: VisibleError) => void,
    private readonly logs: LogBuffer,
  ) {
    this.selected = selectInterface(config.gateway.host);
    this.server = createServer(
      { maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: REQUEST_DEADLINE_MS },
      (req, res) => this.handle(req, res),
    );
    this.server.maxConnections = MAX_CONNECTIONS;
    this.server.maxRequestsPerSocket = 100;
    this.server.keepAliveTimeout = 5_000;
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    this.server.on("error", (error) => {
      this.logs.append({ server: null, level: "error", source: "controller" }, [error]);
      if (!this.closed) {
        this.report(visible(failure("ListenerFailure", "The listener reported an error.")));
        void this.close().catch((error) => this.report(visible(error)));
      }
    });
  }

  static async open(
    config: GatewayConfig,
    report: (error: VisibleError) => void,
    logs = new LogBuffer(),
    control?: SelfProxyOptions,
  ): Promise<GatewayIngress> {
    await rejectSelfProxy(config, control);
    const ingress = new GatewayIngress(config, report, logs);
    try {
      await ingress.reconcile(config, control);
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) =>
          reject(
            failure(
              "ListenerFailure",
              `The listener could not bind the selected address and port. ${backendSummary([error])}`,
            ),
          );
        ingress.server.once("error", failed);
        ingress.server.listen(config.gateway.port, config.gateway.host, () => {
          ingress.server.off("error", failed);
          resolve();
        });
      });
      // DHCP/interface removal must fail closed even without a config edit.
      ingress.monitor = setInterval(() => {
        try {
          ingress.selected = selectInterface(config.gateway.host);
        } catch {
          ingress.report(
            visible(failure("NetworkPolicy", "The selected interface is no longer assigned.")),
          );
          void ingress.close().catch((error) => ingress.report(visible(error)));
        }
      }, 1_000);
      ingress.monitor.unref();
      return ingress;
    } catch (error) {
      await ingress.close();
      throw error;
    }
  }

  get running(): boolean {
    return !this.closed && this.server.listening;
  }
  get address(): string {
    return `http://${this.config.gateway.host}:${this.config.gateway.port}`;
  }

  snapshots(): ServerSnapshot[] {
    return Object.entries(this.config.mcpServers).map(([name, server]) => {
      const error = this.backendErrors.get(name);
      return {
        name,
        type: isHttpServer(server) ? "http" : "stdio",
        endpoint: `${this.address}/mcp/${name}`,
        enabled: !server.disabled,
        status: server.disabled
          ? "disabled"
          : this.endpoints.has(name) && !this.closed
            ? "mounted"
            : this.backendErrors.has(name)
              ? "error"
              : "stopped",
        error: error ? { ...error } : null,
      };
    });
  }

  async reconcile(config: GatewayConfig, control?: SelfProxyOptions): Promise<void> {
    await rejectSelfProxy(config, control);
    if (this.closed) throw failure("Closed", "The listener is closed.");
    this.config = config;
    await Promise.all([...this.closingMounts.keys()].map((name) => this.remove(name)));
    for (const name of this.backendErrors.keys()) {
      if (!Object.hasOwn(config.mcpServers, name)) this.backendErrors.delete(name);
    }
    for (const [name, endpoint] of [...this.endpoints]) {
      const next = Object.hasOwn(config.mcpServers, name) ? config.mcpServers[name] : undefined;
      if (!next || next.disabled || endpoint.fingerprint !== serverFingerprint(next))
        await this.remove(name);
    }
    if (this.closed) throw failure("Closed", "The listener is closed.");
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server.disabled || this.endpoints.has(name)) continue;
      this.backendErrors.delete(name);
      const mount = createMount(
        name,
        server,
        (message) => {
          const error = visible(failure("BackendFailure", message));
          this.backendErrors.set(name, error);
          this.report(error);
        },
        this.admission,
        this.work,
        this.logs,
      );
      this.endpoints.set(name, {
        mount,
        fingerprint: serverFingerprint(server),
        responses: new Set(),
      });
    }
  }

  async restart(name: string, control?: SelfProxyOptions): Promise<void> {
    const server = this.config.mcpServers[name];
    if (!Object.hasOwn(this.config.mcpServers, name) || !server || server.disabled)
      throw failure("BackendFailure", "Select an enabled configured server to restart.");
    await this.remove(name);
    await this.reconcile(this.config, control);
  }

  private async remove(name: string): Promise<void> {
    const endpoint = this.endpoints.get(name);
    if (endpoint) {
      this.endpoints.delete(name);
      for (const response of endpoint.responses) response.destroy();
      this.closingMounts.set(name, endpoint.mount);
    }
    const mount = this.closingMounts.get(name);
    if (!mount) return;
    await closeMount(mount, (error) =>
      this.logs.append({ server: name, level: "error", source: "logger" }, [error]),
    );
    if (this.closingMounts.get(name) === mount) this.closingMounts.delete(name);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reject = (status: number) => {
      res.statusCode = status;
      res.setHeader("Connection", "close");
      if (status === 401) res.setHeader("WWW-Authenticate", "Bearer");
      res.end();
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const authorization = req.headers.authorization;
    const presented =
      typeof authorization === "string" && /^Bearer /i.test(authorization)
        ? authorization.slice(7)
        : "";
    if (!timingSafeEqual(digest(presented), digest(this.config.gateway.token))) {
      reject(401);
      return;
    }
    if (this.closed) {
      reject(503);
      return;
    }
    // Refresh immediately before dispatch, not just on the monitoring timer.
    try {
      this.selected = selectInterface(this.config.gateway.host);
    } catch {
      reject(503);
      void this.close().catch((error) => this.report(visible(error)));
      return;
    }
    if (!peerAllowed(req.socket.remoteAddress ?? "", this.selected)) {
      reject(403);
      return;
    }
    const { host, port } = this.config.gateway;
    if (req.headers.host !== `${host}:${port}` && !(port === 80 && req.headers.host === host)) {
      reject(403);
      return;
    }
    if (req.headers.origin !== undefined && req.headers.origin !== new URL(this.address).origin) {
      reject(403);
      return;
    }
    if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
      reject(405);
      return;
    }
    const match = /^\/mcp\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(req.url ?? "");
    if (!match) {
      reject(404);
      return;
    }
    const name = match[1];
    const endpoint = this.endpoints.get(name);
    if (!endpoint) {
      reject(404);
      return;
    }
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      reject(413);
      return;
    }
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
      reject(415);
      return;
    }
    if (Date.now() - this.rateStart >= 60_000) {
      this.rateStart = Date.now();
      this.rateCount = 0;
    }
    if (
      ++this.rateCount > MAX_REQUESTS_PER_MINUTE ||
      this.activeRequests >= MAX_CONCURRENT_REQUESTS
    ) {
      reject(429);
      return;
    }
    this.activeRequests++;
    endpoint.responses.add(res);
    let bytes = 0;
    let finished = false;
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.statusCode = 504;
        res.end();
      } else res.destroy();
    }, REQUEST_DEADLINE_MS);
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        if (!res.headersSent) {
          res.statusCode = 413;
          res.setHeader("Connection", "close");
          res.end();
        } else res.destroy();
        req.destroy();
      }
    };
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      req.off("data", count);
      this.activeRequests--;
      endpoint.responses.delete(res);
    };
    req.on("data", count);
    res.once("finish", done);
    res.once("close", done);
    try {
      endpoint.mount.app(req, res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end();
      } else res.destroy();
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOwned().catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    this.closed = true;
    if (this.monitor) clearInterval(this.monitor);
    this.listenerStopped ??= new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    for (const socket of this.sockets) socket.destroy();
    const names = new Set([...this.endpoints.keys(), ...this.closingMounts.keys()]);
    const results = await Promise.allSettled([...names].map((name) => this.remove(name)));
    await this.listenerStopped;
    if (results.some((result) => result.status === "rejected"))
      throw failure("ShutdownFailure", "One or more backends did not close cleanly.");
  }
}
