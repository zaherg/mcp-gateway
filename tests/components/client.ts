import { vi } from "vitest";
import type { LogPage, LogQuery } from "../../src/shared/logs";
import type {
  AppClient,
  AppResult,
  AppSnapshot,
  QuitRequest,
  QuitStatus,
} from "../../src/shared/rpc";
import type { GatewayConfig } from "../../src/shared/types";

export const config: GatewayConfig = {
  gateway: {
    host: "127.0.0.1",
    port: 8765,
    token: "synthetic-component-token-0123456789",
    autoStart: false,
    launchAtLogin: false,
  },
  mcpServers: {},
};
export function snapshot(): AppSnapshot {
  return {
    platform: "macos",
    gateway: {
      configFormat: "json",
      configPath: "/synthetic/mcp.json",
      configText: JSON.stringify(config),
      revision: "a".repeat(64),
      running: false,
      address: null,
      interfaces: [{ name: "lo0", address: "127.0.0.1", netmask: "255.0.0.0", loopback: true }],
      servers: [],
      events: [],
      configError: null,
      operationalError: null,
    },
    login: { enabled: false, supported: true, error: null },
    update: {
      supported: true,
      installationEnabled: true,
      automaticUpdates: true,
      installedVersion: "0.3.1",
      availableVersion: null,
      availableHash: null,
      readyVersion: null,
      phase: "idle",
      error: null,
      preferenceError: null,
      recoveryRequired: false,
      recoveryPath: null,
      checkedAt: null,
      attemptId: null,
      transaction: null,
    },
  };
}
export const ok = <T>(value: T): AppResult<T> => ({ ok: true, value });
export const failure = (code: string): AppResult<never> => ({
  ok: false,
  error: { code, message: "Synthetic refusal" },
});
export function fixture(initial = snapshot()) {
  let current = initial;
  const client = {
    readLogs: vi.fn(
      async (_query: LogQuery): Promise<AppResult<LogPage>> =>
        ok({ entries: [], cursor: 0, generation: 0, gap: false, hasMore: false }),
    ),
    clearLogs: vi.fn(
      async (): Promise<AppResult<LogPage>> =>
        ok({ entries: [], cursor: 0, generation: 1, gap: false, hasMore: false }),
    ),
    snapshot: vi.fn(async () => ok(current)),
    quit: vi.fn(
      async (): Promise<AppResult<QuitRequest>> =>
        ok({ requested: true, status: { attempt: 1, phase: "pending", error: null } }),
    ),
    quitStatus: vi.fn(
      async (): Promise<AppResult<QuitStatus>> => ok({ attempt: 0, phase: "idle", error: null }),
    ),
    start: vi.fn(async (): Promise<AppResult<AppSnapshot>> => failure("ListenerFailure")),
    stop: vi.fn(async () => failure("ShutdownFailure")),
    restartServer: vi.fn(async () => failure("BackendFailure")),
    saveConfig: vi.fn(
      async (_params: {
        text: string;
        expectedRevision: string;
      }): Promise<AppResult<AppSnapshot>> => failure("StaleRevision"),
    ),
    copyEndpoint: vi.fn(async (): Promise<AppResult<null>> => failure("OperationFailed")),
    copyClientConfig: vi.fn(async (): Promise<AppResult<null>> => failure("OperationFailed")),
    updatesStatus: vi.fn(async () => ok(current.update)),
    updatesCheck: vi.fn(async () => ok(current.update)),
    updatesDownload: vi.fn(async () => ok(current.update)),
    updatesSetAutomatic: vi.fn(async () => ok(current.update)),
    updatesRestart: vi.fn(
      async (): Promise<AppResult<QuitRequest>> =>
        ok({ requested: true, status: { attempt: 1, phase: "pending", error: null } }),
    ),
  } satisfies AppClient;
  return {
    client,
    set: (next: AppSnapshot) => {
      current = next;
    },
  };
}
