import type { ConfigIssue } from '@mcp-gateway/shared/config-document';
import type { LanguagePreference, LanguageState } from '@mcp-gateway/shared/i18n';
import type {
  GatewaySnapshot,
  LogPage,
  LogQuery,
  ServerCheckResult,
  UpdateDownloadProgress,
} from '@mcp-gateway/shared/types';

export type { UpdateDownloadProgress } from '@mcp-gateway/shared/types';

export interface LoginStatus {
  occurrenceId?: string;
  enabled: boolean;
  supported: boolean;
  error: string | null;
}

export const needsLoginRetry = (status: LoginStatus, wanted: boolean) => {
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
  progressPercent?: number | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  downloadProgress?: UpdateDownloadProgress | null;
  error: string | null;
  checkedAt: string | null;
}

export const APPEARANCE_PREFERENCES = ['system', 'light', 'dark'] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export const parseAppearancePreference = (value: unknown): AppearancePreference | undefined =>
  typeof value === 'string' && (APPEARANCE_PREFERENCES as readonly string[]).includes(value)
    ? (value as AppearancePreference)
    : undefined;

export interface AppSnapshot {
  gateway: GatewaySnapshot;
  login: LoginStatus;
  update: UpdateStatus;
  /** The installed version while its release notes are waiting to be shown, else null. */
  whatsNew: string | null;
  /** Show the Overview reminder: keys can move to Keychain and the user has not retired it. */
  keyReminder: boolean;
  language: LanguageState;
  appearance: AppearancePreference;
}

export const SOCIAL_LINK_TARGETS = ['docs', 'github', 'x'] as const;

export type SocialLinkTarget = (typeof SOCIAL_LINK_TARGETS)[number];

export type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; occurrenceId?: string } };

/** One fixed, sanitized configuration problem from the read-only native check. */
interface ConfigPreview {
  issue: ConfigIssue | null;
}

export type MenuCommand =
  | 'tab:overview'
  | 'tab:logs'
  | 'tab:settings'
  | 'tab:raw-config'
  | 'server:add'
  | 'updates:open'
  | 'gateway:reload';

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
      testServer: {
        params: { name: string; expectedRevision: string };
        response: AppResult<ServerCheckResult>;
      };
      saveConfig: {
        params: { text: string; expectedRevision: string };
        response: AppResult<AppSnapshot>;
      };
      migrateKeys: {
        params: { gateway: boolean; servers: string[]; expectedRevision: string };
        response: AppResult<AppSnapshot>;
      };
      dismissKeyReminder: { params: undefined; response: AppResult<AppSnapshot> };
      validateConfig: { params: { text: string }; response: AppResult<ConfigPreview> };
      confirmDiscard: { params: undefined; response: AppResult<boolean> };
      confirmDeleteServer: { params: { name: string }; response: AppResult<boolean> };
      copyEndpoint: { params: { name: string }; response: AppResult<null> };
      copyClientConfig: { params: { name: string }; response: AppResult<null> };
      openSocialLink: { params: { target: SocialLinkTarget }; response: AppResult<null> };
      revealConfig: { params: undefined; response: AppResult<null> };
      openConfigInEditor: { params: undefined; response: AppResult<null> };
      importExternalServers: {
        params: { expectedRevision: string };
        response: AppResult<{ snapshot: AppSnapshot; importedCount: number }>;
      };
      dismissWhatsNew: { params: undefined; response: AppResult<null> };
      updatesCheck: { params: undefined; response: AppResult<UpdateStatus> };
      updatesDownload: { params: undefined; response: AppResult<UpdateStatus> };
      updatesInstall: { params: undefined; response: AppResult<UpdateStatus> };
      updatesSetAutomatic: {
        params: { automatic: boolean };
        response: AppResult<UpdateStatus>;
      };
      setLanguage: {
        params: { preference: LanguagePreference };
        response: AppResult<AppSnapshot>;
      };
      setAppearance: {
        params: { preference: AppearancePreference };
        response: AppResult<AppSnapshot>;
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
      hasUnsavedRawConfig: { params: undefined; response: boolean };
    };
    messages: {
      snapshotChanged: AppSnapshot;
      menuCommand: { command: MenuCommand };
    };
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
export type AppClient = { [Name in keyof Requests]: Method<Requests[Name]> } & {
  onSnapshotChanged?: (listener: (snapshot: AppSnapshot) => void) => () => void;
  onMenuCommand?: (listener: (command: MenuCommand) => void) => () => void;
};
