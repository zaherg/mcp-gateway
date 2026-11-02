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
} from "../shared/rpc";
import type { GatewayController } from "../shared/types";

export interface LoginManager {
  status(): LoginStatus;
  setEnabled(enabled: boolean): LoginStatus;
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
    };
  }

  private run<A>(work: () => Promise<A> | A): Promise<AppResult<A>> {
    const effect = this.semaphore.withPermits(1)(
      Effect.tryPromise({ try: async () => work(), catch: (error) => error }),
    );
    return Effect.runPromise(Effect.result(effect)).then((result) => {
      if (Result.isSuccess(result)) return { ok: true, value: result.success };
      const error = result.failure;
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
                code: "OperationFailed",
                message: "The application operation failed. Open Logs for details.",
              }),
        },
      };
    });
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
      this.run(() => {
        empty(input);
        return this.snapshot();
      }),
    quit: (input?: unknown) =>
      this.run(() => {
        empty(input);
        const status = this.desktop.requestQuit();
        // The accepted attempt identifies later failures, not completed cleanup.
        return { requested: true as const, status };
      }),
    quitStatus: (input?: unknown) =>
      this.run(() => {
        empty(input);
        return this.desktop.quitStatus();
      }),
    start: (input?: unknown) =>
      this.run(async () => {
        empty(input);
        await this.controller.start();
        return this.snapshot();
      }),
    stop: (input?: unknown) =>
      this.run(async () => {
        empty(input);
        await this.controller.stop();
        return this.snapshot();
      }),
    restartServer: (input: unknown) =>
      this.run(async () => {
        await this.controller.restartServer(serverName(input));
        return this.snapshot();
      }),
    saveConfig: (input: unknown) =>
      this.run(async () => {
        if (this.desktop.quitStatus().phase !== "idle")
          throw new RequestError("Quit cleanup has started. Retry Quit to close the app.");
        const { text, expectedRevision } = decode(SaveRequest, input);
        if (Buffer.byteLength(text) > MAX_CONFIG_BYTES || !/^[a-f0-9]{64}$/.test(expectedRevision))
          throw new RequestError("The configuration request is invalid.");
        const previous = this.controller.snapshot();
        const config = parseConfig(text, process.env, previous.configFormat);
        // Persist first: a stale/invalid save must never mutate macOS registration.
        // OS registration is a separate, observable result, not an atomic file operation.
        await this.controller.saveConfig(text, expectedRevision);
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
      }),
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
  };
}
