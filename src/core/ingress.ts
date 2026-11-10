import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { GatewayMount } from '@mcp-gateway/core/adapter';
import { backendSummary, closeMount, createMount } from '@mcp-gateway/core/adapter';
import {
  effectiveServerToken,
  isHttpServer,
  SAFE_NAME,
  serverFingerprint,
} from '@mcp-gateway/core/config';
import { failure, visible } from '@mcp-gateway/core/errors';
import {
  BackendCalls,
  MAX_BACKEND_CALLS,
  RequestBodyError,
  ResourceAdmission,
  readRequestBody,
} from '@mcp-gateway/core/limits';
import { LogBuffer } from '@mcp-gateway/core/logs';
import {
  peerAllowed,
  rejectSelfProxy,
  type SelfProxyOptions,
  selectInterface,
} from '@mcp-gateway/core/network';
import type {
  GatewayConfig,
  InterfaceChoice,
  ServerSnapshot,
  VisibleError,
} from '@mcp-gateway/shared/types';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_BACKEND_RESOURCES = 16;
// Each session holds a backend resource and at most one open event stream, so
// this cap also bounds the long-lived requests counted against concurrency.
const MAX_SESSIONS = 8;
const REQUEST_DEADLINE_MS = 30_000;
const MAX_CONNECTIONS = 64;
const MAX_REQUESTS_PER_MINUTE = 240;
interface Endpoint {
  mount: GatewayMount;
  fingerprint: string;
  responses: Set<ServerResponse>;
  /** Also serves session-based MCP: GET event streams and DELETE. */
  sessions: boolean;
}
const digest = (text: string) => createHash('sha256').update(text).digest();

export class GatewayIngress {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly backendErrors = new Map<string, VisibleError>();
  private readonly closingMounts = new Map<string, GatewayMount>();
  private readonly admission = new ResourceAdmission(MAX_BACKEND_RESOURCES);
  private readonly sessionAdmission = new ResourceAdmission(MAX_SESSIONS);
  // One backend-work budget shared by every endpoint.
  private readonly work = new BackendCalls(MAX_BACKEND_CALLS);
  private selected: InterfaceChoice;
  private active = 0;
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
    private readonly onInterfaceLost?: (ingress: GatewayIngress) => void,
  ) {
    this.selected = selectInterface(config.gateway.host);
    this.server = createServer(
      { maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: REQUEST_DEADLINE_MS },
      (req, res) => this.handle(req, res),
    );
    this.server.maxConnections = MAX_CONNECTIONS;
    this.server.maxRequestsPerSocket = 100;
    this.server.keepAliveTimeout = 5_000;
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    this.server.on('error', (error) => {
      this.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
      if (!this.closed) {
        this.report(visible(failure('ListenerFailure', 'The listener reported an error.')));
        void this.close().catch((error) => this.report(visible(error)));
      }
    });
  }

  static async open(
    config: GatewayConfig,
    report: (error: VisibleError) => void,
    logs = new LogBuffer(),
    control?: SelfProxyOptions,
    onInterfaceLost?: (ingress: GatewayIngress) => void,
  ): Promise<GatewayIngress> {
    await rejectSelfProxy(config, control);
    const ingress = new GatewayIngress(config, report, logs, onInterfaceLost);
    try {
      await ingress.reconcile(config, control);
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) =>
          reject(
            failure(
              'ListenerFailure',
              `The listener could not bind the selected address and port. ${backendSummary([error])}`,
            ),
          );
        ingress.server.once('error', failed);
        ingress.server.listen(config.gateway.port, config.gateway.host, () => {
          ingress.server.off('error', failed);
          resolve();
        });
      });
      // DHCP/interface removal must fail closed even without a config edit.
      ingress.monitor = setInterval(() => {
        try {
          ingress.selected = selectInterface(config.gateway.host);
        } catch {
          ingress.lostInterface();
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
        type: isHttpServer(server) ? 'http' : 'stdio',
        endpoint: `${this.address}/mcp/${name}`,
        enabled: !server.disabled,
        status: server.disabled
          ? 'disabled'
          : this.endpoints.has(name) && !this.closed
            ? 'mounted'
            : this.backendErrors.has(name)
              ? 'error'
              : 'stopped',
        error: error ? { ...error } : null,
      };
    });
  }

  private lostInterface(): void {
    if (this.closed) return;
    this.report(
      visible(
        failure(
          'NetworkPolicy',
          'The selected interface is no longer assigned. The listener stopped and restarts when the address returns.',
        ),
      ),
    );
    // The owner decides whether to reopen; this listener stays closed either way.
    this.onInterfaceLost?.(this);
    void this.close().catch((error) => this.report(visible(error)));
  }

  async reconcile(config: GatewayConfig, control?: SelfProxyOptions): Promise<void> {
    await rejectSelfProxy(config, control);
    if (this.closed) throw failure('Closed', 'The listener is closed.');
    this.config = config;
    await Promise.all([...this.closingMounts.keys()].map((name) => this.remove(name)));
    for (const name of this.backendErrors.keys()) {
      if (!Object.hasOwn(config.mcpServers, name)) this.backendErrors.delete(name);
    }
    // Detach every changed endpoint before awaiting any close, so a new key never
    // reaches an old mount while another one is still shutting down.
    const stale = [...this.endpoints].filter(([name, endpoint]) => {
      const next = Object.hasOwn(config.mcpServers, name) ? config.mcpServers[name] : undefined;
      return !next || next.disabled || endpoint.fingerprint !== serverFingerprint(next);
    });
    await Promise.all(stale.map(([name]) => this.remove(name)));
    if (this.closed) throw failure('Closed', 'The listener is closed.');
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server.disabled || this.endpoints.has(name)) continue;
      this.backendErrors.delete(name);
      const mount = createMount(
        name,
        server,
        (message) => {
          const error = visible(failure('BackendFailure', message));
          this.backendErrors.set(name, error);
          this.report(error);
        },
        this.admission,
        this.work,
        this.sessionAdmission,
        this.logs,
      );
      this.endpoints.set(name, {
        mount,
        fingerprint: serverFingerprint(server),
        responses: new Set(),
        sessions: server.legacyProtocol === true,
      });
    }
  }

  async restart(name: string, control?: SelfProxyOptions): Promise<void> {
    const server = this.config.mcpServers[name];
    if (!Object.hasOwn(this.config.mcpServers, name) || !server || server.disabled)
      throw failure('BackendFailure', 'Select an enabled configured server to restart.');
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
      this.logs.append({ server: name, level: 'error', source: 'logger' }, [error]),
    );
    if (this.closingMounts.get(name) === mount) this.closingMounts.delete(name);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reject = (status: number) => {
      res.statusCode = status;
      res.setHeader('Connection', 'close');
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      res.end();
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const authorization = req.headers.authorization;
    const presented =
      typeof authorization === 'string' && /^Bearer /i.test(authorization)
        ? authorization.slice(7)
        : '';
    // Only an exact configured route selects a token; an unknown path keeps the
    // global one so it still answers 401/404 without probing server names.
    const name = req.url?.startsWith('/mcp/') ? req.url.slice(5) : '';
    const target =
      SAFE_NAME.test(name) && Object.hasOwn(this.config.mcpServers, name)
        ? this.config.mcpServers[name]
        : undefined;
    const expected = target
      ? effectiveServerToken(this.config.gateway, target)
      : this.config.gateway.token;
    if (!timingSafeEqual(digest(presented), digest(expected))) {
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
      this.lostInterface();
      return;
    }
    if (!peerAllowed(req.socket.remoteAddress ?? '', this.selected)) {
      reject(403);
      return;
    }
    const { host, port } = this.config.gateway;
    if (req.headers.host !== `${host}:${port}` && !(port === 80 && req.headers.host === host)) {
      reject(403);
      return;
    }
    // The host is a validated IPv4 address; a URL origin omits the default port.
    const origin = port === 80 ? `http://${host}` : this.address;
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      reject(403);
      return;
    }
    if (!SAFE_NAME.test(name)) {
      reject(404);
      return;
    }
    const endpoint = this.endpoints.get(name);
    if (!endpoint) {
      reject(404);
      return;
    }
    // MCP 2026-07-28 is stateless: every message is a POST. Session-based MCP
    // adds a session's GET event stream and its DELETE.
    const methods = endpoint.sessions ? ['POST', 'GET', 'DELETE'] : ['POST'];
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', '));
      reject(405);
      return;
    }
    const post = req.method === 'POST';
    const stream = req.method === 'GET';
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      reject(413);
      return;
    }
    if (!post && (req.headers['transfer-encoding'] !== undefined || Number(length ?? 0) > 0)) {
      reject(400);
      return;
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      reject(415);
      return;
    }
    if (Date.now() - this.rateStart >= 60_000) {
      this.rateStart = Date.now();
      this.rateCount = 0;
    }
    if (this.active >= MAX_CONCURRENT_REQUESTS || this.rateCount >= MAX_REQUESTS_PER_MINUTE) {
      reject(429);
      return;
    }
    // Charge once before reading. Refused and disconnected parsers never refund
    // tokens, and settlement in a later minute cannot corrupt that window.
    this.rateCount++;
    this.active++;
    const controller = new AbortController();
    const requestError = () => {
      controller.abort();
      res.destroy();
    };
    req.once('error', requestError);
    req.once('close', () => req.off('error', requestError));
    let finished = false;
    const timeout = setTimeout(() => {
      // An open event stream lives as long as its session; only its opening is bounded.
      if (stream && res.headersSent) return;
      if (!res.headersSent) reject(504);
      else res.destroy();
      controller.abort();
      req.destroy();
    }, REQUEST_DEADLINE_MS);
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      controller.abort();
      this.active--;
      endpoint.responses.delete(res);
    };
    endpoint.responses.add(res);
    res.once('finish', done);
    res.once('close', done);
    void (async () => {
      try {
        if (post) await readRequestBody(req, MAX_BODY_BYTES, controller.signal);
        if (
          finished ||
          controller.signal.aborted ||
          this.closed ||
          this.endpoints.get(name) !== endpoint
        )
          return;
        endpoint.mount.app(req, res);
      } catch (error) {
        if (finished || controller.signal.aborted) return;
        if (!(error instanceof RequestBodyError))
          this.logs.append({ server: name, level: 'error', source: 'controller' }, [error]);
        if (!res.headersSent) reject(error instanceof RequestBodyError ? error.status : 502);
        else res.destroy();
      }
    })();
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
    if (results.some((result) => result.status === 'rejected'))
      throw failure('ShutdownFailure', 'One or more backends did not close cleanly.');
  }
}
