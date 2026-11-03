import { Effect, Result, Schema, Semaphore } from "effect";
import { MAX_CONFIG_BYTES, parseConfig, SAFE_NAME } from "../core/config";
import { GatewayError } from "../core/errors";
import { LOG_LEVELS, LOG_LIMITS } from "../shared/logs";
import {
  type AppResult,
  type AppSnapshot,
  type DesktopPlatform,
  type LoginStatus,
  needsLoginRetry,
  type QuitStatus,
  type UpdateStatus,
} from "../shared/rpc";
import type { GatewayController } from "../shared/types";
import { UpdatePolicyError } from "./updater/coordinator";
import type { UpdateAttempt } from "./updater/transaction";

export interface LoginManager {
  status(): LoginStatus;
  setEnabled(enabled: boolean): LoginStatus;
}

export interface UpdateManager {
  statusValue(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  setAutomatic(enabled: boolean): Promise<UpdateStatus>;
  beginRestart(version: string, hash: string): UpdateAttempt;
  restartToUpdate(
    version: string,
    hash: string,
    admittedAttempt?: UpdateAttempt,
  ): Promise<QuitStatus>;
}

function unsupportedUpdateStatus(): UpdateStatus {
  return {
    supported: false,
    installationEnabled: false,
    automaticUpdates: false,
    installedVersion: null,
    availableVersion: null,
    availableHash: null,
    readyVersion: null,
    phase: "unsupported",
    error: null,
    preferenceError: null,
    recoveryRequired: false,
    recoveryPath: null,
    checkedAt: null,
  };
}

class RequestError extends Error {
  readonly code = "InvalidRequest";
}

let requestSequence = 0;
const LogRequest = Schema.Struct({
  after: Schema.Number,
  level: Schema.optional(Schema.String),
  server: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
const NameRequest = Schema.Struct({ name: Schema.String });
const SaveRequest = Schema.Struct({ text: Schema.String, expectedRevision: Schema.String });
const AutomaticRequest = Schema.Struct({ automatic: Schema.Boolean });
const RestartUpdateRequest = Schema.Struct({ version: Schema.String, hash: Schema.String });

function decode<A, I>(schema: Schema.Codec<A, I>, input: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
  } catch {
    throw new RequestError("The application request is invalid.");
  }
}

function empty(input: unknown): void {
  if (input !== undefined && input !== null)
    throw new RequestError("This operation does not accept parameters.");
}

function serverName(input: unknown): string {
  const { name } = decode(NameRequest, input);
  if (!SAFE_NAME.test(name)) throw new RequestError("Select a configured server.");
  return name;
}

/** Runtime-validated local RPC boundary. No exception may echo a raw request. */
export class AppService {
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private loginStatus: LoginStatus;
  constructor(
    readonly controller: GatewayController,
    private readonly login: LoginManager,
    private readonly copyText: (text: string) => void,
    private readonly desktop: {
      platform: DesktopPlatform;
      requestQuit: () => QuitStatus;
      quitStatus: () => QuitStatus;
    },
    private readonly updates?: UpdateManager,
  ) {
    this.loginStatus = login.status();
  }

  private snapshot(): AppSnapshot {
    // A later cleanup step can fail after the login library has been released.
    if (this.desktop.quitStatus().phase === "idle") this.loginStatus = this.login.status();
    return {
      platform: this.desktop.platform,
      gateway: this.controller.snapshot(),
      login: this.loginStatus,
      update: this.updates?.statusValue() ?? unsupportedUpdateStatus(),
    };
  }

  /** Map any failure to a sanitized local RPC result, never to a raw request. */
  private reply<A>(result: { ok: true; value: A } | { ok: false; error: unknown }): AppResult<A> {
    if (result.ok) return { ok: true, value: result.value };
    const error = result.error;
    if (
      !(error instanceof GatewayError) &&
      !(error instanceof RequestError) &&
      !(error instanceof UpdatePolicyError)
    )
      this.controller.recordLocalError(error);
    return {
      ok: false,
      error: {
        occurrenceId:
          error instanceof GatewayError ? error.occurrenceId : `request-${++requestSequence}`,
        ...(error instanceof GatewayError ||
        error instanceof RequestError ||
        error instanceof UpdatePolicyError
          ? { code: error.code, message: error.message }
          : {
              code: "OperationFailed",
              message: "The application operation failed. Open Logs for details.",
            }),
      },
    };
  }

  private settle<A>(work: () => Promise<A> | A, serialized: boolean): Promise<AppResult<A>> {
    const attempt = Effect.tryPromise({ try: async () => work(), catch: (error) => error });
    const effect = serialized ? this.semaphore.withPermits(1)(attempt) : attempt;
    return Effect.runPromise(Effect.result(effect)).then((result) =>
      Result.isSuccess(result)
        ? this.reply({ ok: true, value: result.success })
        : this.reply({ ok: false, error: result.failure }),
    );
  }

  private runAfterAdmission<Admission, A>(
    admit: () => Admission,
    work: (admission: Admission) => Promise<A> | A,
  ): Promise<AppResult<A>> {
    let admission: Admission;
    try {
      admission = admit();
    } catch (error) {
      return Promise.resolve(this.reply({ ok: false, error }));
    }
    return this.run(() => work(admission));
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
        if (
          !Number.isSafeInteger(query.after) ||
          query.after < 0 ||
          (query.level !== undefined && !LOG_LEVELS.some((level) => level === query.level)) ||
          (query.server !== undefined && !SAFE_NAME.test(query.server)) ||
          (query.text !== undefined && query.text.length > LOG_LIMITS.queryTextCharacters)
        )
          throw new RequestError("The log query is invalid.");
        const level = LOG_LEVELS.find((level) => level === query.level);
        return this.controller.readLogs({ ...query, level });
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
    saveConfig: (input: unknown) => {
      const operation = this.controller.operation();
      return this.run(async () => {
        if (
          this.desktop.quitStatus().phase !== "idle" ||
          this.updates?.statusValue().phase === "restarting"
        )
          throw new RequestError("Quit cleanup has started. Retry Quit to close the app.");
        const { text, expectedRevision } = decode(SaveRequest, input);
        if (Buffer.byteLength(text) > MAX_CONFIG_BYTES || !/^[a-f0-9]{64}$/.test(expectedRevision))
          throw new RequestError("The configuration request is invalid.");
        const previous = this.controller.snapshot();
        const config = parseConfig(text, process.env, previous.configFormat);
        // Persist first: a stale/invalid save must never mutate macOS registration.
        // OS registration is a separate, observable result, not an atomic file operation.
        await this.controller.saveConfig(text, expectedRevision, operation);
        // Quit cleanup may have begun while this save waited; do not touch a
        // login library that native cleanup may already have released.
        if (this.desktop.quitStatus().phase !== "idle") return this.snapshot();
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
    copyEndpoint: (input: unknown) =>
      this.run(() => {
        const name = serverName(input);
        const server = this.controller.snapshot().servers.find((entry) => entry.name === name);
        if (!server) throw new RequestError("Select a configured server.");
        this.copyText(server.endpoint);
        return null;
      }),
    copyClientConfig: (input: unknown) =>
      this.run(() => {
        const name = serverName(input);
        const snapshot = this.controller.snapshot();
        if (snapshot.configError)
          throw new RequestError("Correct the configuration before copying it.");
        const server = snapshot.servers.find((entry) => entry.name === name);
        if (!server) throw new RequestError("Select a configured server.");
        const config = parseConfig(snapshot.configText, process.env, snapshot.configFormat);
        // A local, explicit copy action is the only place expanded credentials leave main.
        this.copyText(
          JSON.stringify(
            {
              mcpServers: {
                [name]: {
                  url: server.endpoint,
                  headers: { Authorization: `Bearer ${config.gateway.token}` },
                },
              },
            },
            null,
            2,
          ),
        );
        return null;
      }),
    updatesStatus: (input?: unknown) =>
      this.lifecycle(() => {
        empty(input);
        return this.requireUpdates().statusValue();
      }),
    updatesCheck: (input?: unknown) =>
      this.lifecycle(async () => {
        empty(input);
        return this.requireUpdates().check();
      }),
    updatesDownload: (input?: unknown) =>
      this.lifecycle(async () => {
        empty(input);
        return this.requireUpdates().download();
      }),
    updatesSetAutomatic: (input: unknown) =>
      this.run(async () => {
        const { automatic } = decode(AutomaticRequest, input);
        return this.requireUpdates().setAutomatic(automatic);
      }),
    updatesRestart: (input: unknown) =>
      this.runAfterAdmission(
        () => {
          const quitPhase = this.desktop.quitStatus().phase;
          if (quitPhase === "pending" || quitPhase === "ready")
            throw new RequestError("Quit cleanup has started. Retry Quit to close the app.");
          const { version, hash } = decode(RestartUpdateRequest, input);
          if (version.length === 0 || version.length > 256 || !/^[a-z0-9]{1,13}$/.test(hash))
            throw new RequestError("The update request is invalid.");
          // Publish the authoritative reservation before the service semaphore.
          return this.requireUpdates().beginRestart(version, hash);
        },
        async (attempt) => {
          const { version, hash } = decode(RestartUpdateRequest, input);
          const status = await this.requireUpdates().restartToUpdate(version, hash, attempt);
          return { requested: true as const, status };
        },
      ),
  };

  private requireUpdates(): UpdateManager {
    if (!this.updates) throw new UpdatePolicyError("UpdateUnsupported");
    return this.updates;
  }
}
