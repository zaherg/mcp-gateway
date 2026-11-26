import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { GatewayMount } from '@mcp-gateway/core/adapter';
import { backendSummary, closeMount, createMount } from '@mcp-gateway/core/adapter';
import { effectiveServerToken, isHttpServer, serverFingerprint } from '@mcp-gateway/core/config';
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
  type CompiledPeerRange,
  compileAllowedPeers,
  peerAllowed,
  rejectSelfProxy,
  type SelfProxyOptions,
  selectInterface,
  validateHostHeader,
  validateOriginHeader,
} from '@mcp-gateway/core/network';
import { checkEndpoint } from '@mcp-gateway/core/test-server';
import { SAFE_NAME } from '@mcp-gateway/shared/config-document';
import type {
  GatewayConfig,
  InterfaceChoice,
  ServerCheckResult,
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
  current: boolean;
  responses: Set<ServerResponse>;
  /** Also serves session-based MCP: GET event streams and DELETE. */
  sessions: boolean;
}
interface AdmittedRequest {
  name: string;
  endpoint: Endpoint;
  post: boolean;
  stream: boolean;
}
const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

export const tokenMatches = (actual: string, expected: string | undefined): boolean => {
  const leftDigest = digest(actual);
  const rightDigest = digest(expected ?? '');
  const matches = timingSafeEqual(leftDigest, rightDigest);
  return Boolean(expected) && actual.length > 0 && matches;
};

export type PreventIdleSleep = () => () => void;

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
  private allowedPeerRanges: readonly CompiledPeerRange[] | undefined;
  private active = 0;
  private rateStart = Date.now();
  private rateCount = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private listenerStopped: Promise<void> | undefined;
  private releaseSleepAssertion?: () => void;
  private monitor: ReturnType<typeof setInterval> | undefined;
  // One manual server test at a time; removing its endpoint or closing the listener aborts it.
  private check: { name: string; stop: AbortController } | undefined;

  private constructor(
    private config: GatewayConfig,
    private readonly report: (error: VisibleError) => void,
    private readonly logs: LogBuffer,
    private readonly onInterfaceLost?: (ingress: GatewayIngress) => void,
    private readonly preventIdleSleep?: PreventIdleSleep,
  ) {
    this.selected = selectInterface(config.gateway.host);
    this.allowedPeerRanges = compileAllowedPeers(config.gateway.allowedPeers);
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
    this.server.on('upgrade', (req, socket) => {
      const { host, port } = this.config.gateway;
      if (
        !validateHostHeader(req.headers.host, host, port) ||
        !validateOriginHeader(req.headers.origin, host, port)
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      socket.end(
        'HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
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
    preventIdleSleep?: PreventIdleSleep,
  ): Promise<GatewayIngress> {
    await rejectSelfProxy(config, control);
    const ingress = new GatewayIngress(config, report, logs, onInterfaceLost, preventIdleSleep);
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
      ingress.syncSleepAssertion();
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

  private syncSleepAssertion(): void {
    try {
      if (this.running && this.config.gateway.keepAwake) {
        if (!this.preventIdleSleep) throw new Error('Idle sleep control is unavailable.');
        this.releaseSleepAssertion ??= this.preventIdleSleep();
      } else {
        // Clear first: a release that throws must never end the same native token twice.
        const release = this.releaseSleepAssertion;
        this.releaseSleepAssertion = undefined;
        release?.();
      }
    } catch (error) {
      this.logs.append({ server: null, level: 'warn', source: 'controller' }, [
        'Could not update idle sleep prevention:',
        error,
      ]);
    }
  }

  async reconcile(config: GatewayConfig, control?: SelfProxyOptions): Promise<void> {
    await rejectSelfProxy(config, control);
    if (this.closed) throw failure('Closed', 'The listener is closed.');
    const previous = this.config;
    this.config = config;
    this.allowedPeerRanges = compileAllowedPeers(config.gateway.allowedPeers);
    this.syncSleepAssertion();
    for (const name of this.backendErrors.keys()) {
      if (!Object.hasOwn(config.mcpServers, name)) this.backendErrors.delete(name);
    }
    const wanted = (name: string) =>
      Object.hasOwn(config.mcpServers, name) && !config.mcpServers[name]?.disabled;
    // Detach every changed endpoint before awaiting any close, so a new key never
    // reaches an old mount while another one is still shutting down.
    const stale = [...this.endpoints].filter(([name, endpoint]) => {
      const next = Object.hasOwn(config.mcpServers, name) ? config.mcpServers[name] : undefined;
      const isStale = !next || next.disabled || endpoint.fingerprint !== serverFingerprint(next);
      if (isStale) endpoint.current = false;
      return isStale;
    });
    const closing = new Map(stale.map(([name]) => [name, this.remove(name)]));
    for (const name of this.closingMounts.keys())
      if (!closing.has(name)) closing.set(name, this.remove(name));
    for (const [name, closed] of closing) {
      closing.set(
        name,
        closed.catch((error) => {
          const visibleError = visible(error);
          if (wanted(name)) this.backendErrors.set(name, visibleError);
          this.report(visibleError);
        }),
      );
    }
    await Promise.all(
      Object.entries(config.mcpServers).map(async ([name, entry]) => {
        if (entry.disabled || this.endpoints.has(name)) return;
        const fingerprint = serverFingerprint(entry);
        const old = Object.hasOwn(previous.mcpServers, name)
          ? previous.mcpServers[name]
          : undefined;
        if (closing.has(name)) {
          // An unchanged name's older cleanup is still owned, but is not this save's work.
          if (
            !stale.some(([detached]) => detached === name) &&
            old &&
            !old.disabled &&
            serverFingerprint(old) === fingerprint
          )
            return;
          await closing.get(name);
        }
        if (this.closed) throw failure('Closed', 'The listener is closed.');
        if (this.endpoints.has(name) || this.closingMounts.has(name)) return;
        this.backendErrors.delete(name);
        const mount = createMount(
          name,
          entry,
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
          fingerprint,
          current: true,
          responses: new Set(),
          sessions: entry.legacyProtocol === true,
        });
      }),
    );
    if (this.closed) throw failure('Closed', 'The listener is closed.');
  }

  async restart(name: string, control?: SelfProxyOptions): Promise<void> {
    const server = this.config.mcpServers[name];
    if (!Object.hasOwn(this.config.mcpServers, name) || !server || server.disabled)
      throw failure('BackendFailure', 'Select an enabled configured server to restart.');
    await this.remove(name);
    await this.reconcile(this.config, control);
  }

  async testServer(name: string): Promise<ServerCheckResult> {
    const server = Object.hasOwn(this.config.mcpServers, name)
      ? this.config.mcpServers[name]
      : undefined;
    const endpoint = this.endpoints.get(name);
    if (!server || !endpoint || !this.running || !this.serves(name, endpoint))
      throw failure('BackendFailure', 'Start the gateway and this server, then test again.');
    if (this.check) throw failure('BackendFailure', 'Another server test is running.');
    const check = { name, stop: new AbortController() };
    this.check = check;
    try {
      return await checkEndpoint({
        url: new URL(`${this.address}/mcp/${name}`),
        token: effectiveServerToken(this.config.gateway, server),
        server,
        stopped: check.stop.signal,
      });
    } finally {
      if (this.check === check) this.check = undefined;
    }
  }

  private async remove(name: string): Promise<void> {
    if (this.check?.name === name) this.check.stop.abort();
    const endpoint = this.endpoints.get(name);
    if (endpoint) {
      endpoint.current = false;
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

  /** Whether this endpoint is mounted and was built from the route's current, enabled entry. */
  private serves(name: string, endpoint: Endpoint): boolean {
    return !this.closed && endpoint.current && this.endpoints.get(name) === endpoint;
  }

  private rejectRequest(res: ServerResponse, status: number): void {
    res.statusCode = status;
    res.setHeader('Connection', 'close');
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res.end();
  }

  private admitRequest(req: IncomingMessage, res: ServerResponse): AdmittedRequest | null {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.removeHeader('Access-Control-Allow-Origin');
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
    if (!tokenMatches(presented, expected)) {
      this.rejectRequest(res, 401);
      return null;
    }
    if (this.closed) {
      this.rejectRequest(res, 503);
      return null;
    }
    // Refresh immediately before dispatch, not just on the monitoring timer.
    try {
      this.selected = selectInterface(this.config.gateway.host);
    } catch {
      this.rejectRequest(res, 503);
      this.lostInterface();
      return null;
    }
    if (!peerAllowed(req.socket.remoteAddress ?? '', this.selected, this.allowedPeerRanges)) {
      this.rejectRequest(res, 403);
      return null;
    }
    const { host, port } = this.config.gateway;
    if (!validateHostHeader(req.headers.host, host, port)) {
      this.rejectRequest(res, 403);
      return null;
    }
    // The host is a validated IPv4 address; a URL origin omits the default port.
    if (!validateOriginHeader(req.headers.origin, host, port)) {
      this.rejectRequest(res, 403);
      return null;
    }
    if (!SAFE_NAME.test(name)) {
      this.rejectRequest(res, 404);
      return null;
    }
    const endpoint = this.endpoints.get(name);
    // Reconcile can keep a previous-configuration endpoint mounted while it waits
    // for earlier cleanup; it must never answer for the current route's key.
    if (!endpoint || !this.serves(name, endpoint)) {
      this.rejectRequest(res, 404);
      return null;
    }
    // MCP 2026-07-28 is stateless: every message is a POST. Session-based MCP
    // adds a session's GET event stream and its DELETE.
    const methods = endpoint.sessions ? ['POST', 'GET', 'DELETE'] : ['POST'];
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', '));
      this.rejectRequest(res, 405);
      return null;
    }
    const post = req.method === 'POST';
    const stream = req.method === 'GET';
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      this.rejectRequest(res, 413);
      return null;
    }
    if (!post && (req.headers['transfer-encoding'] !== undefined || Number(length ?? 0) > 0)) {
      this.rejectRequest(res, 400);
      return null;
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      this.rejectRequest(res, 415);
      return null;
    }
    if (Date.now() - this.rateStart >= 60_000) {
      this.rateStart = Date.now();
      this.rateCount = 0;
    }
    if (this.active >= MAX_CONCURRENT_REQUESTS || this.rateCount >= MAX_REQUESTS_PER_MINUTE) {
      this.rejectRequest(res, 429);
      return null;
    }
    // Charge once before reading. Refused and disconnected parsers never refund
    // tokens, and settlement in a later minute cannot corrupt that window.
    this.rateCount++;
    this.active++;
    return { name, endpoint, post, stream };
  }

  private dispatchEndpoint(
    req: IncomingMessage,
    res: ServerResponse,
    admitted: AdmittedRequest,
  ): void {
    const { name, endpoint, post, stream } = admitted;
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
      if (!res.headersSent) this.rejectRequest(res, 504);
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
        if (finished || controller.signal.aborted || this.closed || !this.serves(name, endpoint))
          return;
        await endpoint.mount.handle(req, res);
      } catch (error) {
        if (finished || controller.signal.aborted) return;
        if (!(error instanceof RequestBodyError))
          this.logs.append({ server: name, level: 'error', source: 'controller' }, [error]);
        if (!res.headersSent)
          this.rejectRequest(res, error instanceof RequestBodyError ? error.status : 502);
        else res.destroy();
      }
    })();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const admitted = this.admitRequest(req, res);
    if (!admitted) return;
    this.dispatchEndpoint(req, res, admitted);
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
    this.syncSleepAssertion();
    this.check?.stop.abort();
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
