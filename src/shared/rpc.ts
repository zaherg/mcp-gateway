import type { LogPage, LogQuery } from "./logs";
import type { GatewaySnapshot } from "./types";

export interface LoginStatus {
  occurrenceId?: string;
  enabled: boolean;
  supported: boolean;
  error: string | null;
}

export function needsLoginRetry(status: LoginStatus, wanted: boolean): boolean {
  return status.supported && (status.error !== null || status.enabled !== wanted);
}

export type DesktopPlatform = "macos" | "linux";

export type QuitStatus =
  | { attempt: number; phase: "idle" | "pending" | "ready"; error: null }
  | { attempt: number; phase: "failed"; error: string };

export interface QuitRequest {
  requested: true;
  status: QuitStatus;
}

export interface AppSnapshot {
  platform: DesktopPlatform;
  gateway: GatewaySnapshot;
  login: LoginStatus;
}

export interface ViewportPolicy {
  supported: boolean;
  documentOverscroll: string;
  bodyOverscroll: string;
  bodyBackground: string;
}

export type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; occurrenceId?: string } };

export type AppRPC = {
  bun: {
    requests: {
      readLogs: { params: LogQuery; response: AppResult<LogPage> };
      clearLogs: { params: undefined; response: AppResult<LogPage> };
      snapshot: { params: undefined; response: AppResult<AppSnapshot> };
      quit: { params: undefined; response: AppResult<QuitRequest> };
      quitStatus: { params: undefined; response: AppResult<QuitStatus> };
      start: { params: undefined; response: AppResult<AppSnapshot> };
      stop: { params: undefined; response: AppResult<AppSnapshot> };
      restartServer: { params: { name: string }; response: AppResult<AppSnapshot> };
      saveConfig: {
        params: { text: string; expectedRevision: string };
        response: AppResult<AppSnapshot>;
      };
      copyEndpoint: { params: { name: string }; response: AppResult<null> };
      copyClientConfig: { params: { name: string }; response: AppResult<null> };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: {
      viewportPolicy: { params: undefined; response: ViewportPolicy };
      smokeQuit: { params: undefined; response: boolean };
    };
    messages: Record<string, never>;
  };
};

export interface AppClient {
  readLogs(params: LogQuery): Promise<AppResult<LogPage>>;
  clearLogs(): Promise<AppResult<LogPage>>;
  snapshot(): Promise<AppResult<AppSnapshot>>;
  quit(): Promise<AppResult<QuitRequest>>;
  quitStatus(): Promise<AppResult<QuitStatus>>;
  start(): Promise<AppResult<AppSnapshot>>;
  stop(): Promise<AppResult<AppSnapshot>>;
  restartServer(params: { name: string }): Promise<AppResult<AppSnapshot>>;
  saveConfig(params: { text: string; expectedRevision: string }): Promise<AppResult<AppSnapshot>>;
  copyEndpoint(params: { name: string }): Promise<AppResult<null>>;
  copyClientConfig(params: { name: string }): Promise<AppResult<null>>;
}
