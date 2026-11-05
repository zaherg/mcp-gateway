// Audited against Supergateway 4.2.1 and its locked SDKs. These declarations
// describe only the lifecycle seams used by adapter.ts, not a stable public API.
declare module "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js" {
  import type { ChildProcess, SpawnOptions } from "node:child_process";
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
  export interface GatewayRequest extends IncomingMessage {
    body?: unknown;
  }
  export interface GatewayResponse extends ServerResponse {
    status(code: number): GatewayResponse;
    send(body: string): GatewayResponse;
    json(body: unknown): GatewayResponse;
  }
  export interface GatewayApp {
    (request: IncomingMessage, response: ServerResponse): void;
    post(
      path: string,
      handler: (req: GatewayRequest, res: GatewayResponse, next: (error?: unknown) => void) => void,
    ): void;
    get(
      path: string,
      handler: (req: GatewayRequest, res: GatewayResponse, next: (error?: unknown) => void) => void,
    ): void;
    delete(
      path: string,
      handler: (req: GatewayRequest, res: GatewayResponse, next: (error?: unknown) => void) => void,
    ): void;
    use(
      handler: (
        error: unknown,
        req: GatewayRequest,
        res: GatewayResponse,
        next: (error?: unknown) => void,
      ) => void,
    ): void;
  }
  export interface StatefulMount {
    app: GatewayApp;
    path: string;
    listening(host: string, port: number): void;
    close(): Promise<void>;
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
    type: "streamableHttp";
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
}
declare module "express" {
  // Passed unchanged to streamableHttpApp; all Express use stays inside Supergateway.
  const express: object;
  export default express;
}
declare module "cors" {
  const cors: object;
  export default cors;
}
declare module "supergateway/dist/lib/streamableHttpApp.js" {
  import type {
    GatewayApp,
    GatewayLogger,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  export function streamableHttpApp(
    express: object,
    cors: object,
    options: {
      headers: Record<string, string>;
      exposedHeaders: string[];
      healthEndpoints: string[];
      apiKeys: string[];
      logger: GatewayLogger;
    },
  ): GatewayApp;
}
declare module "supergateway/dist/lib/ownedChildProcesses.js" {
  import type { ChildProcess, SpawnOptions } from "node:child_process";
  import type {
    ChildrenOwner,
    GatewayLogger,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  export class OwnedChildProcesses implements ChildrenOwner {
    constructor(logger: GatewayLogger);
    readonly closing: boolean;
    readonly spawnOptions: SpawnOptions;
    own(child: ChildProcess): () => Promise<void>;
    track(stop: () => Promise<void>): () => Promise<void>;
    close(): Promise<void>;
  }
}
declare module "supergateway/dist/lib/childCommand.js" {
  import type { ChildProcessWithoutNullStreams, SpawnOptions, spawn } from "node:child_process";
  import type { Command } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  export function spawnCommand(
    spawnProcess: typeof spawn,
    command: Command,
    options: SpawnOptions & { stdio: "pipe" },
  ): ChildProcessWithoutNullStreams;
}
declare module "supergateway/dist/lib/outputBackpressure.js" {
  export function readWhile(response: Response, wait: () => Promise<void> | undefined): Response;
}
declare module "supergateway/dist/gateways/statefulSessions.js" {
  import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
  import type {
    ChildrenOwner,
    GatewayLogger,
    GatewayRequest,
    GatewayResponse,
    Source,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  export class StatefulSessions {
    constructor(
      source: Source,
      children: ChildrenOwner,
      logger: GatewayLogger,
      sessionTimeout: number,
    );
    readonly openResponses: WeakMap<StreamableHTTPServerTransport, Set<GatewayResponse>>;
    /** Session id to its established transport; used only for pre-dispatch refusal. */
    readonly transports: Map<string, StreamableHTTPServerTransport>;
    open(res: GatewayResponse): Promise<StreamableHTTPServerTransport>;
    post(req: GatewayRequest, res: GatewayResponse): Promise<void>;
    request(req: GatewayRequest, res: GatewayResponse): Promise<void>;
  }
}
declare module "supergateway/dist/gateways/statefulSession.js" {
  import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
  import type { StatefulSessions } from "supergateway/dist/gateways/statefulSessions.js";
  import type {
    GatewayLogger,
    GatewayResponse,
    PeerFactory,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  export class StatefulSession {
    readonly transport: StreamableHTTPServerTransport;
    settle(requestId: string | number): boolean;
    endCancelled(requestId: unknown): void;
    static open(
      sessions: StatefulSessions,
      res: GatewayResponse,
      logger: GatewayLogger,
      sessionTimeout: number,
      begin: (
        transport: StreamableHTTPServerTransport,
        responses: Set<GatewayResponse>,
      ) => PeerFactory,
    ): Promise<StatefulSession>;
  }
}
declare module "supergateway/dist/lib/modernAdmission.js" {
  import type { InboundModernRoute } from "@modelcontextprotocol/server";
  import type {
    GatewayRequest,
    GatewayResponse,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  export type HeaderValue = (name: string) => string | undefined;
  export function headerValue(req: GatewayRequest): HeaderValue;
  export function paramHeaders(req: GatewayRequest): Record<string, string>;
  export function admit(
    req: GatewayRequest,
    res: GatewayResponse,
    value: HeaderValue,
    speaks: () => boolean | Promise<boolean>,
  ): Promise<boolean | InboundModernRoute>;
  export function rejectWith(
    req: GatewayRequest,
    res: GatewayResponse,
    status: number,
    error: { code: number; message: string },
  ): void;
}
declare module "supergateway/dist/lib/modernSdk.js" {
  export { PerRequestHTTPServerTransport } from "@modelcontextprotocol/server";
}
declare module "supergateway/dist/lib/retainedChildren.js" {
  import type { JSONRPCMessage } from "@modelcontextprotocol/server";
  import type { GatewayLogger } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  export interface ModernChild {
    onmessage?: (message: JSONRPCMessage) => void;
    onerror?: (error: Error) => void;
    onclose?: () => void;
    start(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
    hold(drained: Promise<void>): void;
    finish(): Promise<void>;
    close(): Promise<void>;
  }
  export interface ReusedChild {
    child: ModernChild;
    state: unknown;
  }
  export const CONTINUATION_TIMEOUT: number;
  export const RETAINED_CHILD_LIMIT: number;
  export function isContinuationHandle(state: unknown): state is string;
  export class RetainedChildren {
    constructor(options: { idleMs: number; limit: number; logger: GatewayLogger });
    take(handle: string, signal: AbortSignal): Promise<ReusedChild | undefined>;
    close(): Promise<void>;
  }
}
declare module "supergateway/dist/lib/ownedStdioTransport.js" {
  import type { ChildProcessWithoutNullStreams } from "node:child_process";
  import type {
    ChildrenOwner,
    Command,
    GatewayLogger,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  import type { ModernChild } from "supergateway/dist/lib/retainedChildren.js";
  export const OwnedStdioTransport: new (
    command: Command,
    owner: ChildrenOwner,
    logger: GatewayLogger,
  ) => ModernChild & {
    child?: ChildProcessWithoutNullStreams;
    stop?: () => Promise<void>;
    watch(child: ChildProcessWithoutNullStreams): void;
    deliver(line: string): void;
  };
}
declare module "supergateway/dist/lib/upstreamModernChild.js" {
  import type {
    GatewayLogger,
    Upstream,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  import type { ModernChild } from "supergateway/dist/lib/retainedChildren.js";
  export const UpstreamModernChild: new (
    upstream: Upstream,
    declared: { version: string | undefined; params: Record<string, string> },
    logger: GatewayLogger,
  ) => ModernChild & {
    readonly reading: Set<Promise<void>>;
    readonly held?: Promise<void>;
    read(response: Response, awaited?: string | number): Promise<void>;
    events(response: Response, deliver: (value: unknown) => void): Promise<void>;
  };
  export const MODERN_VERSION: string;
  export const SPEAKS_FOR_MS: number;
}
declare module "supergateway/dist/lib/getVersion.js" {
  export function getVersion(): string;
}
declare module "supergateway/dist/lib/modernRequest.js" {
  import type {
    InboundModernRoute,
    PerRequestHTTPServerTransport,
  } from "@modelcontextprotocol/server";
  import type {
    ChildrenOwner,
    GatewayLogger,
    GatewayRequest,
    GatewayResponse,
  } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
  import type { HeaderValue } from "supergateway/dist/lib/modernAdmission.js";
  import type {
    ModernChild,
    RetainedChildren,
    ReusedChild,
  } from "supergateway/dist/lib/retainedChildren.js";
  export class ModernRequest {
    constructor(at: {
      req: GatewayRequest;
      res: GatewayResponse;
      route: InboundModernRoute;
      value: HeaderValue;
      transport: PerRequestHTTPServerTransport;
      reused?: ReusedChild;
      child: ModernChild;
      retained: RetainedChildren;
      active: Set<() => Promise<void>>;
      children: ChildrenOwner;
      logger: GatewayLogger;
    });
    serve(): Promise<boolean>;
    stop(): Promise<void>;
  }
}
