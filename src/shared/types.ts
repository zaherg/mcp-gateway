import type { ConfigFormat } from '@mcp-gateway/shared/config-document';

export const LOG_LIMITS = Object.freeze({
  entries: 500,
  bytes: 4 * 1024 * 1024,
  entryBytes: 32 * 1024,
  batchEntries: 50,
  batchBytes: 256 * 1024,
  requestTimeoutMs: 10_000,
  queryTextCharacters: 512,
});
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export interface LogEntry {
  id: number;
  time: string;
  server: string | null;
  level: LogLevel;
  source: 'logger' | 'stderr' | 'controller';
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

interface GatewaySettings {
  host: string;
  port: number;
  autoStart?: boolean;
  launchAtLogin?: boolean;
  keepAwake?: boolean;
  /** IPv4 client ranges that replace the selected interface's netmask check. */
  allowedPeers?: string[];
}

/** A key slot as written in the file: the key itself, or the ID of its Keychain item. */
export interface KeySlot {
  token?: string;
  tokenRef?: string;
}

/** The resolved configuration: every Keychain reference is replaced by its key. */
export interface GatewayConfig {
  gateway: GatewaySettings & { token: string };
  mcpServers: Record<string, StdioServerConfig | HttpServerConfig>;
}

/** The configuration as written in the file, where the global key may be a Keychain reference. */
export interface ConfigFile {
  gateway: GatewaySettings & KeySlot;
  mcpServers: Record<string, StdioServerConfig | HttpServerConfig>;
}

interface ServerBase extends KeySlot {
  disabled?: boolean;
  /** Also serve session-based MCP (2025-11-25 and earlier) on this endpoint. */
  legacyProtocol?: boolean;
}

export interface StdioServerConfig extends ServerBase {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpServerConfig extends ServerBase {
  url: string;
  headers?: Record<string, string>;
}

/** How clients reach a listener address. `tailscale` is a tunnel interface in 100.64.0.0/10. */
export type NetworkKind = 'loopback' | 'lan' | 'tailscale' | 'tunnel';

export interface InterfaceChoice {
  name: string;
  address: string;
  netmask: string;
  kind: NetworkKind;
}

export type GatewayErrorCode =
  | 'InvalidConfig'
  /** A valid file whose stored key cannot be read; the form stays open so Generate can replace it. */
  | 'KeyUnavailable'
  | 'AmbiguousConfig'
  | 'UnsafeFile'
  | 'ConfigIO'
  | 'StaleRevision'
  | 'ConfigLocked'
  | 'NetworkPolicy'
  | 'BackendFailure'
  | 'ListenerFailure'
  | 'ShutdownFailure'
  | 'Cancelled'
  | 'Closed';

export interface VisibleError {
  occurrenceId: string;
  code: GatewayErrorCode;
  message: string;
}

export interface ServerSnapshot {
  name: string;
  type: 'stdio' | 'http';
  endpoint: string;
  enabled: boolean;
  /** Mounted means ingress is available; no backend handshake is implied. */
  status: 'stopped' | 'mounted' | 'error' | 'disabled';
  error: VisibleError | null;
}

export interface GatewaySnapshot {
  configPath: string;
  configFormat: ConfigFormat;
  /** Explicit local configuration surface. Contains credentials; never log it. */
  configText: string;
  revision: string;
  running: boolean;
  interfaces: InterfaceChoice[];
  /** Kind of the saved listener address; null while it is not assigned or the configuration is invalid. */
  network: NetworkKind | null;
  /** Slots whose saved key is a literal that can move to Keychain. Names only, never values. */
  keyMigration: KeyMigration;
  servers: ServerSnapshot[];
  configError: VisibleError | null;
  operationalError: VisibleError | null;
}

export interface KeyMigration {
  gateway: boolean;
  servers: string[];
}

/** Keychain access for gateway keys. There is deliberately no delete. */
export interface KeyStore {
  /** Reads every ID within one deadline; fails with fixed text if any is missing or unreadable. */
  get(refs: readonly string[]): Promise<Map<string, string>>;
  /** Creates or replaces one item; refuses an empty value, which would delete it. */
  set(ref: string, value: string): Promise<void>;
}

/** One completed handshake through a running endpoint; nothing else is reported. */
export interface ServerCheckResult {
  protocolVersion: string;
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
  /** One MCP handshake through the saved, mounted endpoint, as a client would send it. */
  testServer(name: string, expectedRevision: string): Promise<ServerCheckResult>;
  saveConfig(
    text: string,
    expectedRevision: string,
    operation?: GatewayOperation,
  ): Promise<GatewaySnapshot>;
  /** Moves literal keys into new Keychain items and saves their references in their place. */
  migrateKeys(
    slots: KeyMigration,
    expectedRevision: string,
    operation?: GatewayOperation,
  ): Promise<GatewaySnapshot>;
  /** The configuration the gateway uses, with resolved keys; undefined before one is accepted. */
  activeConfig(): GatewayConfig | undefined;
  close(): Promise<void>;
}
