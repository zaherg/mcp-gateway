import type { ConfigFormat } from "@mcp-gateway/shared/config-document";

export const LOG_LIMITS = Object.freeze({
  entries: 500,
  bytes: 4 * 1024 * 1024,
  entryBytes: 32 * 1024,
  batchEntries: 50,
  batchBytes: 256 * 1024,
  requestTimeoutMs: 10_000,
  queryTextCharacters: 512,
});
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export interface LogEntry {
  id: number;
  time: string;
  server: string | null;
  level: LogLevel;
  source: "logger" | "stderr" | "controller";
  text: string;
  truncated: boolean;
}
export interface LogQuery {
  after: number;
}
export interface LogPage {
  entries: LogEntry[];
  cursor: number;
  generation: number;
  gap: boolean;
  hasMore: boolean;
}

export interface GatewayConfig {
  gateway: {
    host: string;
    port: number;
    token: string;
    autoStart?: boolean;
    launchAtLogin?: boolean;
  };
  mcpServers: Record<string, StdioServerConfig | HttpServerConfig>;
}

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  /** Also serve session-based MCP (2025-11-25 and earlier) on this endpoint. */
  legacyProtocol?: boolean;
}

export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Also serve session-based MCP (2025-11-25 and earlier) on this endpoint. */
  legacyProtocol?: boolean;
}

export interface InterfaceChoice {
  name: string;
  address: string;
  netmask: string;
  loopback: boolean;
}

export type GatewayErrorCode =
  | "InvalidConfig"
  | "AmbiguousConfig"
  | "UnsafeFile"
  | "ConfigIO"
  | "StaleRevision"
  | "ConfigLocked"
  | "NetworkPolicy"
  | "BackendFailure"
  | "ListenerFailure"
  | "ShutdownFailure"
  | "Cancelled"
  | "Closed";

export interface VisibleError {
  occurrenceId: string;
  code: GatewayErrorCode;
  message: string;
}

export interface ServerSnapshot {
  name: string;
  type: "stdio" | "http";
  endpoint: string;
  enabled: boolean;
  /** Mounted means ingress is available; no backend handshake is implied. */
  status: "stopped" | "mounted" | "error" | "disabled";
  error: VisibleError | null;
}

export interface GatewaySnapshot {
  configPath: string;
  configFormat: ConfigFormat;
  /** Explicit local configuration surface. Contains credentials; never log it. */
  configText: string;
  revision: string;
  running: boolean;
  address: string | null;
  interfaces: InterfaceChoice[];
  servers: ServerSnapshot[];
  configError: VisibleError | null;
  operationalError: VisibleError | null;
}

/** Cancellation ownership captured when an operation was requested. */
export interface GatewayOperation {
  readonly signal: AbortSignal;
}

export interface GatewayController {
  readLogs(query: LogQuery): LogPage;
  clearLogs(): LogPage;
  recordLocalError(error: unknown): void;
  snapshot(): GatewaySnapshot;
  /** Capture cancellation ownership before the caller waits on its own queue. */
  operation(): GatewayOperation;
  start(operation?: GatewayOperation): Promise<GatewaySnapshot>;
  stop(): Promise<GatewaySnapshot>;
  restartServer(name: string, operation?: GatewayOperation): Promise<GatewaySnapshot>;
  saveConfig(
    text: string,
    expectedRevision: string,
    operation?: GatewayOperation,
  ): Promise<GatewaySnapshot>;
  close(): Promise<void>;
}
