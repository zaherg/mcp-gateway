import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import * as z from 'zod/v4';

import {
  effectiveServerToken,
  isDisallowedUpstreamUrl,
  parseConfig,
  previewConfig,
} from '@mcp-gateway/core/config';
import { failure, GatewayError, RequestError } from '@mcp-gateway/core/errors';
import { isBlockedEnvironmentKey } from '@mcp-gateway/core/process';
import { anyNumber } from '@mcp-gateway/core/schema';
import { createSerialQueue } from '@mcp-gateway/core/serial-queue';
import type { UpdateRuntime } from '@mcp-gateway/main/app-updater';
import {
  editConfigDocument,
  isRecord,
  MAX_CONFIG_BYTES,
  SAFE_NAME,
} from '@mcp-gateway/shared/config-document';
import {
  type LanguagePreference,
  type LanguageState,
  parseLanguagePreference,
} from '@mcp-gateway/shared/i18n';
import {
  APPEARANCE_PREFERENCES,
  type AppearancePreference,
  type AppResult,
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
const CopyClientConfigRequest = z.strictObject({
  name: z.string(),
  redact: z.boolean().exactOptional(),
});
const TestRequest = z.strictObject({ name: z.string(), expectedRevision: z.string() });
const SaveRequest = z.strictObject({ text: z.string(), expectedRevision: z.string() });
const ImportExternalRequest = z.strictObject({ expectedRevision: z.string() });
const MigrateRequest = z.strictObject({
  gateway: z.boolean(),
  servers: z.array(z.string()).max(64),
  expectedRevision: z.string(),
});
const PreviewRequest = z.strictObject({ text: z.string() });
const AutomaticRequest = z.strictObject({ automatic: z.boolean() });
const SocialLinkRequest = z.strictObject({ target: z.enum(SOCIAL_LINK_TARGETS) });
const LanguageRequest = z.strictObject({ preference: z.string() });
const AppearanceRequest = z.strictObject({ preference: z.enum(APPEARANCE_PREFERENCES) });

const decode = <A>(schema: z.ZodType<A>, input: unknown) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestError('The application request is invalid.');
  return result.data;
};

const empty = (input: unknown) => {
  if (input !== undefined && input !== null)
    throw new RequestError('This operation does not accept parameters.');
};

const serverName = (input: unknown) => {
  const { name } = decode(NameRequest, input);
  if (!SAFE_NAME.test(name)) throw new RequestError('Select a configured server.');
  return name;
};

const missingFile = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const readSafeClientFile = async (filePath: string) => {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return null;
  } catch (error) {
    if (missingFile(error)) return null;
    return null;
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_CONFIG_BYTES) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

const parseExternalServerEntry = (entry: unknown, gatewayHost: string, gatewayPort: number) => {
  if (!isRecord(entry)) return null;
  const hasUrl = Object.hasOwn(entry, 'url');
  const hasCommand = Object.hasOwn(entry, 'command');
  if (hasUrl === hasCommand) return null;

  if (hasUrl) {
    if (typeof entry.url !== 'string' || !entry.url.trim()) return null;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(entry.url);
    } catch {
      return null;
    }
    if (
      !['http:', 'https:'].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.hash ||
      isDisallowedUpstreamUrl(parsedUrl)
    ) {
      return null;
    }
    const urlPort = parsedUrl.port
      ? Number(parsedUrl.port)
      : parsedUrl.protocol === 'https:'
        ? 443
        : 80;
    const isSelfHost =
      parsedUrl.hostname === gatewayHost ||
      parsedUrl.hostname === '127.0.0.1' ||
      parsedUrl.hostname === 'localhost';
    if (isSelfHost && urlPort === gatewayPort && parsedUrl.pathname.startsWith('/mcp/')) {
      return null;
    }
    let headers: Record<string, string> | undefined;
    if (entry.headers !== undefined) {
      if (!isRecord(entry.headers)) return null;
      const cleanHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(entry.headers)) {
        if (typeof val !== 'string') return null;
        if (
          /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|mcp-session-id)$/i.test(
            key,
          )
        )
          return null;
        cleanHeaders[key] = val;
      }
      if (Object.keys(cleanHeaders).length > 0) headers = cleanHeaders;
    }
    return {
      url: entry.url,
      ...(headers ? { headers } : {}),
      ...(typeof entry.disabled === 'boolean' ? { disabled: entry.disabled } : {}),
    };
  }

  if (typeof entry.command !== 'string' || !entry.command.trim()) return null;
  let args: string[] | undefined;
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || !entry.args.every((item) => typeof item === 'string'))
      return null;
    args = [...entry.args];
  }
  let env: Record<string, string> | undefined;
  if (entry.env !== undefined) {
    if (!isRecord(entry.env)) return null;
    const cleanEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(entry.env)) {
      if (typeof val !== 'string') return null;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isBlockedEnvironmentKey(key)) return null;
      cleanEnv[key] = val;
    }
    if (Object.keys(cleanEnv).length > 0) env = cleanEnv;
  }
  let cwd: string | undefined;
  if (entry.cwd !== undefined) {
    if (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)) return null;
    cwd = entry.cwd;
  }
  return {
    command: entry.command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...(typeof entry.disabled === 'boolean' ? { disabled: entry.disabled } : {}),
  };
};

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
  confirmDeleteServer: (name: string) => Promise<boolean>;
  whatsNew: () => string | null;
  dismissWhatsNew: () => Promise<void>;
  keyReminderRetired: () => boolean;
  retireKeyReminder: () => Promise<void>;
  language: () => LanguageState;
  setLanguage: (preference: LanguagePreference) => Promise<void>;
  appearance: () => AppearancePreference;
  setAppearance: (preference: AppearancePreference) => Promise<void>;
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

  private assertIdle(consequence: string) {
    if (this.desktop.quitStatus().phase !== 'idle' || this.updates.status().phase === 'restarting')
      throw new RequestError(`Quit cleanup has started. ${consequence}`);
  }

  currentSnapshot() {
    return this.snapshot();
  }

  private snapshot() {
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
      appearance: this.desktop.appearance(),
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

  private run<A>(work: () => Promise<A> | A) {
    return this.settle(work, true);
  }

  // Stop, Quit and lifecycle status must not wait behind a configuration
  // operation whose validation a Stop or Quit is meant to cancel. Each still
  // validates its own parameters before it can cancel anything.
  private lifecycle<A>(work: () => Promise<A> | A) {
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
    testServer: (input: unknown) =>
      // Not queued: Stop and Quit must not wait behind a slow backend; Stop aborts the test.
      this.lifecycle(async () => {
        const { name, expectedRevision } = decode(TestRequest, input);
        if (!SAFE_NAME.test(name) || !/^[a-f0-9]{64}$/.test(expectedRevision))
          throw new RequestError('Select a configured server.');
        this.assertIdle('The server was not tested.');
        if (this.controller.snapshot().revision !== expectedRevision)
          throw failure(
            'StaleRevision',
            'Save or discard configuration changes before testing a server.',
          );
        return this.controller.testServer(name, expectedRevision);
      }),
    saveConfig: (input: unknown) => {
      const operation = this.controller.operation();
      return this.run(async () => {
        this.assertIdle('Retry Quit to close the app.');
        const { text, expectedRevision } = decode(SaveRequest, input);
        if (Buffer.byteLength(text) > MAX_CONFIG_BYTES || !/^[a-f0-9]{64}$/.test(expectedRevision))
          throw new RequestError('The configuration request is invalid.');
        const previousLogin = this.controller.activeConfig()?.gateway.launchAtLogin ?? false;
        // Persist first: a stale/invalid save must never mutate macOS registration.
        // OS registration is a separate, observable result, not an atomic file operation.
        await this.controller.saveConfig(text, expectedRevision, operation);
        if (this.desktop.quitStatus().phase !== 'idle') return this.snapshot();
        const wanted = this.controller.activeConfig()?.gateway.launchAtLogin ?? false;
        const actual = this.login.status();
        if (
          (actual.supported || (wanted && !previousLogin)) &&
          (wanted !== previousLogin || needsLoginRetry(actual, wanted))
        )
          this.login.setEnabled(wanted);
        return this.snapshot();
      });
    },
    migrateKeys: (input: unknown) => {
      const operation = this.controller.operation();
      return this.run(async () => {
        this.assertIdle('The keys were not moved.');
        const { gateway, servers, expectedRevision } = decode(MigrateRequest, input);
        if (
          (!gateway && servers.length === 0) ||
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
        this.assertIdle('The configuration was not checked.');
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
    confirmDeleteServer: (input: unknown) =>
      this.lifecycle(async () => this.desktop.confirmDeleteServer(serverName(input))),
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
        const { name, redact } = decode(CopyClientConfigRequest, input);
        if (!SAFE_NAME.test(name)) throw new RequestError('Select a configured server.');
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
        const token = redact ? '[REDACTED]' : effectiveServerToken(config.gateway, configured);
        // Only the gateway client endpoint and bearer token are copied; backend server
        // env, headers, args, and upstream URLs never leave main.
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
        this.assertIdle('The link was not opened.');
        if (!this.desktop.openExternal(SOCIAL_LINKS[target]))
          throw new RequestError('The link could not be opened in your default browser.');
        return null;
      }),
    revealConfig: (input?: unknown) =>
      // Read-only and needed during repair: never wait behind a configuration operation.
      this.lifecycle(async () => {
        empty(input);
        this.assertIdle('Finder was not opened.');
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
    openConfigInEditor: (input?: unknown) =>
      this.lifecycle(async () => {
        empty(input);
        this.assertIdle('The configuration file was not opened.');
        const path = this.controller.snapshot().configPath;
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw failure('UnsafeFile', 'Symlinked configuration files are refused.');
        if (!this.desktop.openPath(path))
          throw new RequestError('The configuration file could not be opened.');
        return null;
      }),
    importExternalServers: (input: unknown) => {
      const operation = this.controller.operation();
      return this.run(async () => {
        this.assertIdle('Servers were not imported.');
        const { expectedRevision } = decode(ImportExternalRequest, input);
        if (!/^[a-f0-9]{64}$/.test(expectedRevision))
          throw new RequestError('The configuration request is invalid.');
        const currentSnapshot = this.controller.snapshot();
        if (currentSnapshot.revision !== expectedRevision)
          throw failure(
            'StaleRevision',
            'Save or discard configuration changes before importing servers.',
          );
        const currentConfig = parseConfig(
          currentSnapshot.configText,
          process.env,
          currentSnapshot.configFormat,
        );
        const home = homedir();
        const candidatePaths = [
          join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
          join(home, '.cursor', 'mcp.json'),
        ];
        const nextServers = {
          ...currentConfig.mcpServers,
        };
        let importedCount = 0;

        for (const candidatePath of candidatePaths) {
          const text = await readSafeClientFile(candidatePath);
          if (!text) continue;
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(text);
          } catch {
            continue;
          }
          if (!isRecord(parsedJson) || !isRecord(parsedJson.mcpServers)) continue;
          for (const [name, rawEntry] of Object.entries(parsedJson.mcpServers)) {
            if (!SAFE_NAME.test(name) || Object.hasOwn(nextServers, name)) continue;
            if (Object.keys(nextServers).length >= 64) break;
            const validated = parseExternalServerEntry(
              rawEntry,
              currentConfig.gateway.host,
              currentConfig.gateway.port,
            );
            if (!validated) continue;
            nextServers[name] = validated;
            importedCount += 1;
          }
        }

        if (importedCount > 0) {
          const nextConfig = { ...currentConfig, mcpServers: nextServers };
          const nextText = editConfigDocument(
            currentSnapshot.configText,
            nextConfig,
            currentSnapshot.configFormat,
          );
          await this.controller.saveConfig(nextText, expectedRevision, operation);
        }

        return { snapshot: this.snapshot(), importedCount };
      });
    },
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
    updatesInstall: (input?: unknown) =>
      this.lifecycle(async () => {
        empty(input);
        return this.updates.installUpdate();
      }),
    updatesSetAutomatic: (input: unknown) =>
      this.run(async () => {
        const { automatic } = decode(AutomaticRequest, input);
        return this.updates.setAutomatic(automatic);
      }),
    setLanguage: (input: unknown) =>
      this.run(async () => {
        const { preference: requested } = decode(LanguageRequest, input);
        this.assertIdle('The language was not changed.');
        // Only the locales this build offers.
        const preference = parseLanguagePreference(requested, this.desktop.language().available);
        if (!preference) throw new RequestError('The selected language is not available.');
        await this.desktop.setLanguage(preference);
        return this.snapshot();
      }),
    setAppearance: (input: unknown) =>
      this.run(async () => {
        const { preference } = decode(AppearanceRequest, input);
        this.assertIdle('The appearance was not changed.');
        await this.desktop.setAppearance(preference);
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
