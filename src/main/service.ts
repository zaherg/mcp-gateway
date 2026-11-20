import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

import * as z from 'zod/v4';

import {
  effectiveServerToken,
  MAX_CONFIG_BYTES,
  parseConfig,
  previewConfig,
  SAFE_NAME,
} from '@mcp-gateway/core/config';
import { GatewayError, RequestError } from '@mcp-gateway/core/errors';
import { anyNumber } from '@mcp-gateway/core/schema';
import { createSerialQueue } from '@mcp-gateway/core/serial-queue';
import type { UpdateRuntime } from '@mcp-gateway/main/app-updater';
import {
  type LanguagePreference,
  type LanguageState,
  parseLanguagePreference,
} from '@mcp-gateway/shared/i18n';
import {
  type AppResult,
  type AppSnapshot,
  type LoginStatus,
  needsLoginRetry,
  type QuitStatus,
  SOCIAL_LINK_TARGETS,
  type SocialLinkTarget,
} from '@mcp-gateway/shared/rpc';
import type { GatewayController } from '@mcp-gateway/shared/types';

export interface LoginManager {
  status(): LoginStatus;
  setEnabled(enabled: boolean): LoginStatus;
}

interface ReplySuccess<T> {
  ok: true;
  value: T;
}

interface ReplyFailure {
  ok: false;
  error: unknown;
}

let requestSequence = 0;
const LogRequest = z.strictObject({ after: anyNumber });
const NameRequest = z.strictObject({ name: z.string() });
const TestRequest = z.strictObject({ name: z.string(), expectedRevision: z.string() });
const SaveRequest = z.strictObject({ text: z.string(), expectedRevision: z.string() });
const MigrateRequest = z.strictObject({
  gateway: z.boolean(),
  servers: z.array(z.string()).max(64),
  expectedRevision: z.string(),
});
const PreviewRequest = z.strictObject({ text: z.string() });
const AutomaticRequest = z.strictObject({ automatic: z.boolean() });
const SocialLinkRequest = z.strictObject({ target: z.enum(SOCIAL_LINK_TARGETS) });
const LanguageRequest = z.strictObject({ preference: z.string() });

const decode = <A>(schema: z.ZodType<A>, input: unknown): A => {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestError('The application request is invalid.');
  return result.data;
};

const empty = (input: unknown): void => {
  if (input !== undefined && input !== null)
    throw new RequestError('This operation does not accept parameters.');
};

const serverName = (input: unknown): string => {
  const { name } = decode(NameRequest, input);
  if (!SAFE_NAME.test(name)) throw new RequestError('Select a configured server.');
  return name;
};

const missingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

// The fixed destinations are native-owned so the renderer cannot pass a URL.
const SOCIAL_LINKS: Record<SocialLinkTarget, string> = {
  docs: 'https://github.com/zaherg/mcp-gateway/blob/main/docs/README.md',
  github: 'https://github.com/zaherg/mcp-gateway',
  x: 'https://x.com/zaherg',
};

interface DesktopActions {
  requestQuit: () => QuitStatus;
  quitStatus: () => QuitStatus;
  openExternal: (url: string) => boolean;
  showItemInFolder: (path: string) => void;
  openPath: (path: string) => boolean;
  confirmDiscard: () => Promise<boolean>;
  whatsNew: () => string | null;
  dismissWhatsNew: () => Promise<void>;
  keyReminderRetired: () => boolean;
  retireKeyReminder: () => Promise<void>;
  language: () => LanguageState;
  setLanguage: (preference: LanguagePreference) => Promise<void>;
}

/** Runtime-validated local RPC boundary. No exception may echo a raw request. */
export class AppService {
  private readonly queue = createSerialQueue();
  private loginStatus: LoginStatus;
  constructor(
    readonly controller: GatewayController,
    private readonly login: LoginManager,
    private readonly copyText: (text: string) => void,
    private readonly desktop: DesktopActions,
    private readonly updates: UpdateRuntime,
  ) {
    this.loginStatus = login.status();
  }

  private snapshot(): AppSnapshot {
    // A later cleanup step can fail after the login library has been released.
    if (this.desktop.quitStatus().phase === 'idle') this.loginStatus = this.login.status();
    const gateway = this.controller.snapshot();
    return {
      gateway,
      keyReminder:
        !this.desktop.keyReminderRetired() &&
        (gateway.keyMigration.gateway || gateway.keyMigration.servers.length > 0),
      login: this.loginStatus,
      update: this.updates.status(),
      whatsNew: this.desktop.whatsNew(),
      language: this.desktop.language(),
    };
  }

  /** Map any failure to a sanitized local RPC result, never to a raw request. */
  private reply<A>(result: ReplySuccess<A> | ReplyFailure): AppResult<A> {
    if (result.ok) return { ok: true, value: result.value };
    const error = result.error;
    if (!(error instanceof GatewayError) && !(error instanceof RequestError))
      this.controller.recordLocalError(error);
    return {
      ok: false,
      error: {
        occurrenceId:
          error instanceof GatewayError ? error.occurrenceId : `request-${++requestSequence}`,
        ...(error instanceof GatewayError || error instanceof RequestError
          ? { code: error.code, message: error.message }
          : {
              code: 'OperationFailed',
              message: 'The application operation failed. Open Logs for details.',
            }),
      },
    };
  }

  private settle<A>(work: () => Promise<A> | A, serialized: boolean): Promise<AppResult<A>> {
    const attempt = async () => work();
    return (serialized ? this.queue(attempt) : attempt()).then(
      (value) => this.reply({ ok: true, value }),
      (error) => this.reply({ ok: false, error }),
    );
  }

  private run<A>(work: () => Promise<A> | A): Promise<AppResult<A>> {
    return this.settle(work, true);
  }

  // Stop, Quit and lifecycle status must not wait behind a configuration
  // operation whose validation a Stop or Quit is meant to cancel. Each still
  // validates its own parameters before it can cancel anything.
  private lifecycle<A>(work: () => Promise<A> | A): Promise<AppResult<A>> {
    return this.settle(work, false);
  }

  readonly handlers = {
    readLogs: (input: unknown) =>
      this.run(() => {
        const query = decode(LogRequest, input);
        if (!Number.isSafeInteger(query.after) || query.after < 0)
          throw new RequestError('The log query is invalid.');
        return this.controller.readLogs({ after: query.after });
      }),
    clearLogs: (input?: unknown) =>
      this.run(() => {
        empty(input);
        return this.controller.clearLogs();
      }),
    snapshot: (input?: unknown) =>
      this.lifecycle(() => {
        empty(input);
        return this.snapshot();
      }),
    quit: (input?: unknown) =>
      this.lifecycle(() => {
        empty(input);
        const status = this.desktop.requestQuit();
        // The accepted attempt identifies later failures, not completed cleanup.
        return { requested: true as const, status };
      }),
    quitStatus: (input?: unknown) =>
      this.lifecycle(() => {
        empty(input);
        return this.desktop.quitStatus();
      }),
    start: (input?: unknown) => {
      // Capture cancellation ownership before this request waits for the
      // service queue; a Stop that arrives meanwhile must cancel it.
      const operation = this.controller.operation();
      return this.run(async () => {
        empty(input);
        await this.controller.start(operation);
        return this.snapshot();
      });
    },
    stop: (input?: unknown) =>
      this.lifecycle(async () => {
        empty(input);
        await this.controller.stop();
        return this.snapshot();
      }),
    restartServer: (input: unknown) => {
      const operation = this.controller.operation();
      return this.run(async () => {
        await this.controller.restartServer(serverName(input), operation);
        return this.snapshot();
      });
    },
    testServer: (input: unknown) =>
      // Not queued: Stop and Quit must not wait behind a slow backend; Stop aborts the test.
      this.lifecycle(async () => {
        const { name, expectedRevision } = decode(TestRequest, input);
        if (!SAFE_NAME.test(name) || !/^[a-f0-9]{64}$/.test(expectedRevision))
          throw new RequestError('Select a configured server.');
        if (
          this.desktop.quitStatus().phase !== 'idle' ||
          this.updates.status().phase === 'restarting'
        )
          throw new RequestError('Quit cleanup has started. The server was not tested.');
        return this.controller.testServer(name, expectedRevision);
      }),
    saveConfig: (input: unknown) => {
      const operation = this.controller.operation();
      return this.run(async () => {
        if (
          this.desktop.quitStatus().phase !== 'idle' ||
          this.updates.status().phase === 'restarting'
        )
          throw new RequestError('Quit cleanup has started. Retry Quit to close the app.');
        const { text, expectedRevision } = decode(SaveRequest, input);
        if (Buffer.byteLength(text) > MAX_CONFIG_BYTES || !/^[a-f0-9]{64}$/.test(expectedRevision))
          throw new RequestError('The configuration request is invalid.');
        const previous = this.controller.snapshot();
        const config = parseConfig(text, process.env, previous.configFormat);
        // Persist first: a stale/invalid save must never mutate macOS registration.
        // OS registration is a separate, observable result, not an atomic file operation.
        await this.controller.saveConfig(text, expectedRevision, operation);
        // Quit cleanup may have begun while this save waited; do not touch a
        // login library that native cleanup may already have released.
        if (this.desktop.quitStatus().phase !== 'idle') return this.snapshot();
        let previousLogin = false;
        try {
          previousLogin =
            parseConfig(previous.configText, process.env, previous.configFormat).gateway
              .launchAtLogin ?? false;
        } catch (error) {
          if (!(error instanceof GatewayError)) throw error;
        }
        const wanted = config.gateway.launchAtLogin ?? false;
        const actual = this.login.status();
        if (wanted !== previousLogin || needsLoginRetry(actual, wanted))
          this.login.setEnabled(wanted);
        return this.snapshot();
      });
    },
    migrateKeys: (input: unknown) => {
      const operation = this.controller.operation();
      return this.run(async () => {
        if (
          this.desktop.quitStatus().phase !== 'idle' ||
          this.updates.status().phase === 'restarting'
        )
          throw new RequestError('Quit cleanup has started. The keys were not moved.');
        const { gateway, servers, expectedRevision } = decode(MigrateRequest, input);
        if (
          !/^[a-f0-9]{64}$/.test(expectedRevision) ||
          servers.some((name) => !SAFE_NAME.test(name)) ||
          new Set(servers).size !== servers.length
        )
          throw new RequestError('The key migration request is invalid.');
        // Starting a move retires the reminder for good, whatever the outcome.
        await this.desktop
          .retireKeyReminder()
          .catch((error) => this.controller.recordLocalError(error));
        await this.controller.migrateKeys({ gateway, servers }, expectedRevision, operation);
        return this.snapshot();
      });
    },
    dismissKeyReminder: (input?: unknown) =>
      // Like the release notes, closing the reminder must not wait behind a configuration operation.
      this.lifecycle(async () => {
        empty(input);
        await this.desktop.retireKeyReminder();
        return this.snapshot();
      }),
    validateConfig: (input: unknown) =>
      // Read-only: never wait behind a configuration operation that a later edit supersedes.
      this.settle(() => {
        if (
          this.desktop.quitStatus().phase !== 'idle' ||
          this.updates.status().phase === 'restarting'
        )
          throw new RequestError('Quit cleanup has started. The configuration was not checked.');
        const { text } = decode(PreviewRequest, input);
        if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
          throw new RequestError('The configuration request is invalid.');
        return { issue: previewConfig(text, process.env, this.controller.snapshot().configFormat) };
      }, false),
    confirmDiscard: (input?: unknown) =>
      // The dialog can stay open; it must not hold the configuration queue.
      this.lifecycle(async () => {
        empty(input);
        return this.desktop.confirmDiscard();
      }),
    copyEndpoint: (input: unknown) =>
      this.run(() => {
        const name = serverName(input);
        const server = this.controller.snapshot().servers.find((entry) => entry.name === name);
        if (!server) throw new RequestError('Select a configured server.');
        this.copyText(server.endpoint);
        return null;
      }),
    copyClientConfig: (input: unknown) =>
      this.run(() => {
        const name = serverName(input);
        const snapshot = this.controller.snapshot();
        if (snapshot.configError)
          throw new RequestError('Correct the configuration before copying it.');
        const server = snapshot.servers.find((entry) => entry.name === name);
        if (!server) throw new RequestError('Select a configured server.');
        // The accepted configuration, with keys already resolved: copying never reads Keychain.
        const config = this.controller.activeConfig();
        if (!config) throw new RequestError('Correct the configuration before copying it.');
        const configured = Object.hasOwn(config.mcpServers, name)
          ? config.mcpServers[name]
          : undefined;
        if (!configured) throw new RequestError('Select a configured server.');
        const token = effectiveServerToken(config.gateway, configured);
        // A local, explicit copy action is the only place expanded credentials leave main.
        this.copyText(
          JSON.stringify(
            {
              mcpServers: {
                [name]: {
                  url: server.endpoint,
                  headers: { Authorization: `Bearer ${token}` },
                },
              },
            },
            null,
            2,
          ),
        );
        return null;
      }),
    openSocialLink: (input: unknown) =>
      this.run(() => {
        const { target } = decode(SocialLinkRequest, input);
        if (
          this.desktop.quitStatus().phase !== 'idle' ||
          this.updates.status().phase === 'restarting'
        )
          throw new RequestError('Quit cleanup has started. The link was not opened.');
        if (!this.desktop.openExternal(SOCIAL_LINKS[target]))
          throw new RequestError('The link could not be opened in your default browser.');
        return null;
      }),
    revealConfig: (input?: unknown) =>
      // Read-only and needed during repair: never wait behind a configuration operation.
      this.lifecycle(async () => {
        empty(input);
        if (
          this.desktop.quitStatus().phase !== 'idle' ||
          this.updates.status().phase === 'restarting'
        )
          throw new RequestError('Quit cleanup has started. Finder was not opened.');
        // The path is owned by main; the renderer never supplies one.
        const path = this.controller.snapshot().configPath;
        try {
          await lstat(path);
        } catch (error) {
          if (!missingFile(error)) throw error;
          // A renamed or deleted file: show its folder instead of doing nothing.
          if (!this.desktop.openPath(dirname(path)))
            throw new RequestError('The configuration folder could not be opened in Finder.');
          return null;
        }
        this.desktop.showItemInFolder(path);
        return null;
      }),
    dismissWhatsNew: (input?: unknown) =>
      // Closing the notes must not wait behind a configuration operation.
      this.lifecycle(async () => {
        empty(input);
        await this.desktop.dismissWhatsNew();
        return null;
      }),
    updatesCheck: (input?: unknown) =>
      this.lifecycle(async () => {
        empty(input);
        return this.updates.check();
      }),
    updatesDownload: (input?: unknown) =>
      this.lifecycle(async () => {
        empty(input);
        return this.updates.download();
      }),
    updatesSetAutomatic: (input: unknown) =>
      this.run(async () => {
        const { automatic } = decode(AutomaticRequest, input);
        return this.updates.setAutomatic(automatic);
      }),
    setLanguage: (input: unknown) =>
      this.run(async () => {
        const { preference: requested } = decode(LanguageRequest, input);
        if (
          this.desktop.quitStatus().phase !== 'idle' ||
          this.updates.status().phase === 'restarting'
        )
          throw new RequestError('Quit cleanup has started. The language was not changed.');
        // Only the locales this build offers.
        const preference = parseLanguagePreference(requested, this.desktop.language().available);
        if (!preference) throw new RequestError('The selected language is not available.');
        await this.desktop.setLanguage(preference);
        return this.snapshot();
      }),
    updatesRestart: (input?: unknown) =>
      this.run(async () => {
        empty(input);
        const status = await this.updates.restart();
        return { requested: true as const, status };
      }),
  };
}
