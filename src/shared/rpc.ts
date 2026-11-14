import type { ConfigIssue } from '@mcp-gateway/shared/config-document';
import type { GatewaySnapshot, LogPage, LogQuery } from '@mcp-gateway/shared/types';

export interface LoginStatus {
  occurrenceId?: string;
  enabled: boolean;
  supported: boolean;
  error: string | null;
}

export const needsLoginRetry = (status: LoginStatus, wanted: boolean): boolean => {
  return status.supported && (status.error !== null || status.enabled !== wanted);
};

export type QuitStatus =
  | { attempt: number; phase: 'idle' | 'pending' | 'ready'; error: null }
  | { attempt: number; phase: 'failed'; error: string };

interface QuitRequest {
  requested: true;
  status: QuitStatus;
}

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'restarting'
  | 'error';

export interface UpdateStatus {
  supported: boolean;
  automaticUpdates: boolean;
  installedVersion: string | null;
  availableVersion: string | null;
  phase: UpdatePhase;
  error: string | null;
  checkedAt: string | null;
}

export interface AppSnapshot {
  gateway: GatewaySnapshot;
  login: LoginStatus;
  update: UpdateStatus;
  /** The installed version while its release notes are waiting to be shown, else null. */
  whatsNew: string | null;
}

export const SOCIAL_LINK_TARGETS = ['github', 'x'] as const;

export type SocialLinkTarget = (typeof SOCIAL_LINK_TARGETS)[number];

export type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; occurrenceId?: string } };

/** One fixed, sanitized configuration problem from the read-only native check. */
export interface ConfigPreview {
  issue: ConfigIssue | null;
}

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
      validateConfig: { params: { text: string }; response: AppResult<ConfigPreview> };
      confirmDiscard: { params: undefined; response: AppResult<boolean> };
      copyEndpoint: { params: { name: string }; response: AppResult<null> };
      copyClientConfig: { params: { name: string }; response: AppResult<null> };
      openSocialLink: { params: { target: SocialLinkTarget }; response: AppResult<null> };
      dismissWhatsNew: { params: undefined; response: AppResult<null> };
      updatesCheck: { params: undefined; response: AppResult<UpdateStatus> };
      updatesDownload: { params: undefined; response: AppResult<UpdateStatus> };
      updatesSetAutomatic: {
        params: { automatic: boolean };
        response: AppResult<UpdateStatus>;
      };
      updatesRestart: {
        params: undefined;
        response: AppResult<QuitRequest>;
      };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: {
      interactiveQuit: { params: undefined; response: boolean };
    };
    messages: Record<string, never>;
  };
};

type Requests = AppRPC['bun']['requests'];

// Requests without parameters stay callable with no argument.
type Method<Request> = Request extends { params: infer Params; response: infer Response }
  ? [Params] extends [undefined]
    ? () => Promise<Response>
    : (params: Params) => Promise<Response>
  : never;

/** The renderer-facing client: one method per request in `AppRPC`. */
export type AppClient = { [Name in keyof Requests]: Method<Requests[Name]> };
