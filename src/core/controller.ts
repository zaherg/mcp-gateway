import { type FSWatcher, lstatSync, watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Exit, Result, Scope, Semaphore } from "effect";
import type {
  GatewayConfig,
  GatewayController,
  GatewayEvent,
  GatewayOperation,
  GatewaySnapshot,
  LogQuery,
  VisibleError,
} from "../shared/types";
import { type ConfigDocument, ConfigStore, isHttpServer, parseConfig } from "./config";
import { failure, operational, visible } from "./errors";
import { GatewayIngress } from "./ingress";
import { LogBuffer } from "./logs";
import {
  interfaceChoices,
  isSelfProxyCancelled,
  rejectSelfProxy,
  SELF_PROXY_DEADLINE_MS,
  type SelfProxyOptions,
  type SelfProxyResolver,
  selectInterface,
} from "./network";

/** Internal seams for tests; production callers pass no options. */
export interface ControllerOptions {
  /** Resolver used by every self-proxy check instead of node:dns. */
  resolve?: SelfProxyResolver;
}

/** Local native/UI API. Snapshots contain explicit config credentials; do not log them. */
export class McpGatewayController implements GatewayController {
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private readonly lifetime = Scope.makeUnsafe();
  private readonly store: ConfigStore;
  private document: ConfigDocument = { text: "", revision: "" };
  private config: GatewayConfig | undefined;
  private ingress: GatewayIngress | undefined;
  private closingIngress: GatewayIngress | undefined;
  private configError: VisibleError | null = null;
  private operationalError: VisibleError | null = null;
  private readonly logs = new LogBuffer();
  readLogs(query: LogQuery) {
    return this.logs.read(query);
  }
  clearLogs() {
    return this.logs.clear();
  }
  recordLocalError(error: unknown): void {
    this.logs.append({ server: null, level: "error", source: "controller" }, [
      "Local application operation failed:",
      error,
    ]);
  }

  private readonly events: GatewayEvent[] = [];
  private watcher: FSWatcher | undefined;
  private watchHealthy = false;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private closing = false;
  private validation = new AbortController();
  private closePromise: Promise<void> | undefined;
  private lifetimeClosed: Promise<void> | undefined;

  private constructor(
    configPath: string,
    private readonly resolve?: SelfProxyResolver,
  ) {
    this.store = new ConfigStore(configPath);
  }

  static async open(
    configPath: string,
    options: ControllerOptions = {},
  ): Promise<McpGatewayController> {
    const controller = new McpGatewayController(configPath, options.resolve);
    await controller.serial(async () => {
      const control = controller.control(controller.validationLifetime());
      try {
        controller.document = await controller.store.initialize();
        controller.config = parseConfig(
          controller.document.text,
          process.env,
          controller.store.format,
        );
        selectInterface(controller.config.gateway.host);
        await rejectSelfProxy(controller.config, control);
        controller.event("info", "Configuration loaded.");
      } catch (error) {
        controller.logs.append({ server: null, level: "error", source: "controller" }, [error]);
        controller.configError = visible(error);
        controller.event("error", "Configuration could not be loaded.");
      }
      controller.observe();
      if (controller.config?.gateway.autoStart && !controller.configError) {
        try {
          await controller.startOwned(control);
        } catch (error) {
          controller.operationalError = visible(error);
        }
      }
    });
    return controller;
  }

  snapshot(): GatewaySnapshot {
    const config = this.config;
    const running = this.ingress?.running ?? false;
    return {
      configPath: this.store.path,
      configFormat: this.store.format,
      configText: this.document.text,
      revision: this.document.revision,
      running,
      address: running ? (this.ingress?.address ?? null) : null,
      interfaces: interfaceChoices(),
      servers:
        (running ? this.ingress?.snapshots() : undefined) ??
        Object.entries(config?.mcpServers ?? {}).map(([name, server]) => ({
          name,
          type: isHttpServer(server) ? ("http" as const) : ("stdio" as const),
          endpoint: `http://${config?.gateway.host}:${config?.gateway.port}/mcp/${name}`,
          enabled: !server.disabled,
          status: server.disabled ? ("disabled" as const) : ("stopped" as const),
          error: null,
        })),
      events: this.events.map((entry) => ({ ...entry })),
      configError: this.configError ? { ...this.configError } : null,
      operationalError: this.operationalError ? { ...this.operationalError } : null,
    };
  }

  private event(level: GatewayEvent["level"], message: string): void {
    this.logs.append({ server: null, level, source: "controller" }, [message]);
    this.events.push({ time: new Date().toISOString(), level, message });
    if (this.events.length > 100) this.events.shift();
  }

  private serial<A>(work: () => Promise<A>): Promise<A> {
    const effect = this.semaphore.withPermits(1)(
      operational(
        async () => {
          try {
            return await work();
          } catch (error) {
            this.logs.append({ server: null, level: "error", source: "controller" }, [error]);
            throw error;
          }
        },
        "BackendFailure",
        "The gateway operation failed.",
      ),
    );
    return Effect.runPromise(Effect.result(effect)).then((result) => {
      if (Result.isFailure(result)) throw result.failure;
      return result.success;
    });
  }

  // Operations capture their lifetime when they are requested, so a Stop that
  // arrives while they wait for the queue still cancels them. An operation
  // requested after a Stop starts a fresh lifetime; close stays terminal.
  private validationLifetime(): AbortSignal {
    if (this.validation.signal.aborted) this.validation = new AbortController();
    return this.validation.signal;
  }

  operation(): GatewayOperation {
    return { signal: this.validationLifetime() };
  }

  // An explicitly captured operation keeps the lifetime it was requested with;
  // only calls without one capture a fresh lifetime now.
  private operationSignal(operation?: GatewayOperation): AbortSignal {
    return operation?.signal ?? this.validationLifetime();
  }

  private control(signal: AbortSignal): SelfProxyOptions {
    return {
      resolve: this.resolve,
      signal,
      deadline: Date.now() + SELF_PROXY_DEADLINE_MS,
    };
  }

  private cancelValidation(): void {
    this.validation.abort();
  }

  private ensureOpen(): void {
    if (this.closed || this.closing) throw failure("Closed", "The controller is closed.");
  }

  private report = (error: VisibleError): void => {
    this.logs.append({ server: null, level: "error", source: "controller" }, [error]);
    this.operationalError = error;
    this.event("error", error.message);
  };

  private async startOwned(control: SelfProxyOptions): Promise<void> {
    this.ensureOpen();
    if (!this.watchHealthy)
      throw failure(
        "ConfigIO",
        "Configuration watching is unavailable; reopen the controller before starting.",
      );
    if (this.ingress?.running) return;
    // Read the authoritative bytes again, even if a watch notification is delayed.
    await this.refresh(control);
    if (!this.config || this.configError)
      throw failure("InvalidConfig", "Correct the on-disk configuration before starting.");
    await this.stopOwned();
    const config = this.config;
    try {
      const ingress = await Effect.runPromise(
        operational(
          () => GatewayIngress.open(config, this.report, this.logs, control),
          "ListenerFailure",
          "The listener could not start.",
        ),
      );
      this.closingIngress = ingress;
      this.ensureOpen();
      if (!this.watchHealthy)
        throw failure(
          "ConfigIO",
          "Configuration watching is unavailable; reopen the controller before starting.",
        );
      this.ingress = ingress;
      this.closingIngress = undefined;
      this.operationalError = null;
      this.event("info", "Gateway listener started; backends initialize on client requests.");
    } catch (error) {
      await this.stopOwned();
      throw error;
    }
  }

  private async stopOwned(): Promise<void> {
    const ingress = this.ingress ?? this.closingIngress;
    this.ingress = undefined;
    if (!ingress) return;
    // Stopped/config snapshots must not expose old routes, but a deadline does
    // not release ownership. No replacement can start until this close succeeds.
    this.closingIngress = ingress;
    try {
      await ingress.close();
      if (this.closingIngress === ingress) this.closingIngress = undefined;
      if (this.operationalError?.code === "ShutdownFailure") this.operationalError = null;
      this.event("info", "Gateway listener stopped.");
    } catch (error) {
      this.report(visible(error));
      throw error;
    }
  }

  start(operation?: GatewayOperation): Promise<GatewaySnapshot> {
    const signal = this.operationSignal(operation);
    return this.serial(async () => {
      // The deadline bounds validation, not time spent waiting for the queue.
      const control = this.control(signal);
      try {
        await this.startOwned(control);
        return this.snapshot();
      } catch (error) {
        if (!isSelfProxyCancelled(error)) this.report(visible(error));
        throw error;
      }
    });
  }

  stop(): Promise<GatewaySnapshot> {
    this.cancelValidation();
    return this.serial(async () => {
      this.ensureOpen();
      await this.stopOwned();
      return this.snapshot();
    });
  }

  restartServer(name: string, operation?: GatewayOperation): Promise<GatewaySnapshot> {
    const signal = this.operationSignal(operation);
    return this.serial(async () => {
      const control = this.control(signal);
      this.ensureOpen();
      if (!this.ingress?.running)
        throw failure("BackendFailure", "Start the gateway before restarting a server.");
      try {
        await this.ingress.restart(name, control);
        this.event("info", "A backend endpoint was restarted.");
      } catch (error) {
        if (!isSelfProxyCancelled(error)) this.report(visible(error));
        throw error;
      }
      return this.snapshot();
    });
  }

  saveConfig(
    text: string,
    expectedRevision: string,
    operation?: GatewayOperation,
  ): Promise<GatewaySnapshot> {
    const signal = this.operationSignal(operation);
    return this.serial(async () => {
      const control = this.control(signal);
      this.ensureOpen();
      const next = parseConfig(text, process.env, this.store.format);
      selectInterface(next.gateway.host);
      await rejectSelfProxy(next, control);
      const document = await this.store.save(text, expectedRevision).catch(async (error) => {
        await this.refresh(control);
        throw error;
      });
      await this.apply(document, next, control);
      return this.snapshot();
    });
  }

  private async apply(
    document: ConfigDocument,
    next: GatewayConfig,
    control: SelfProxyOptions,
  ): Promise<void> {
    const previous = this.config;
    const running = this.ingress?.running ?? false;
    this.document = document;
    this.config = next;
    this.configError = this.watchHealthy
      ? null
      : visible(
          failure(
            "ConfigIO",
            "Configuration watching is unavailable; reopen the controller before starting.",
          ),
        );
    if (!running) return;
    try {
      if (
        previous?.gateway.host !== next.gateway.host ||
        previous?.gateway.port !== next.gateway.port ||
        previous?.gateway.token !== next.gateway.token
      ) {
        await this.stopOwned();
        await this.startOwned(control);
      } else await this.ingress?.reconcile(next, control);
    } catch (error) {
      this.report(visible(error));
      await this.stopOwned();
      throw error;
    }
  }

  private async refresh(control: SelfProxyOptions): Promise<void> {
    let document: ConfigDocument | undefined;
    try {
      document = await this.store.read();
      if (document.revision === this.document.revision && !this.configError) return;
      // Validate the candidate before publishing its text/revision. A cancelled
      // refresh must leave document/config consistent so the next Start retries it.
      const next = parseConfig(document.text, process.env, this.store.format);
      selectInterface(next.gateway.host);
      await rejectSelfProxy(next, control);
      await this.apply(document, next, control);
    } catch (error) {
      // A superseded operation leaves the authoritative config and configError alone.
      if (control.signal?.aborted || isSelfProxyCancelled(error)) throw error;
      // Invalid external source stays visible for repair, while the validated
      // config retains the last accepted state.
      if (document) this.document = document;
      this.logs.append({ server: null, level: "error", source: "controller" }, [error]);
      this.configError = visible(error);
      this.event("error", "Invalid external configuration; listener stopped.");
      await this.stopOwned();
    }
  }

  private failWatcher = (): void => {
    if (!this.watchHealthy || this.closed || this.closing) return;
    this.watchHealthy = false;
    void this.serial(async () => {
      this.configError = visible(
        failure(
          "ConfigIO",
          "Configuration watching is unavailable; reopen the controller before starting.",
        ),
      );
      await this.stopOwned();
    }).catch((error) => this.report(visible(error)));
  };

  private observe(): void {
    try {
      const identity = lstatSync(dirname(this.store.path));
      if (!identity.isDirectory() || identity.isSymbolicLink())
        throw failure("UnsafeFile", "The configuration directory is unsafe.");
      this.watcher = watch(dirname(this.store.path), () => {
        if (this.closed || this.closing || !this.watchHealthy) return;
        // Capture cancellation ownership when the event is admitted, before the
        // debounce and controller queue. A Stop that arrives while this event
        // waits must cancel it instead of letting it start a fresh lifetime.
        const signal = this.validationLifetime();
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined;
          void this.serial(async () => {
            if (this.closed || this.closing || !this.watchHealthy) return;
            try {
              const current = await lstat(dirname(this.store.path));
              if (
                !current.isDirectory() ||
                current.isSymbolicLink() ||
                current.dev !== identity.dev ||
                current.ino !== identity.ino
              ) {
                this.failWatcher();
                return;
              }
            } catch {
              this.failWatcher();
              return;
            }
            await this.refresh(this.control(signal));
          }).catch((error) => {
            if (!isSelfProxyCancelled(error)) this.report(visible(error));
          });
        }, 20);
      });
      this.watchHealthy = true;
      this.watcher.on("error", this.failWatcher);
      this.watcher.on("close", this.failWatcher);
      Effect.runSync(
        Scope.addFinalizer(
          this.lifetime,
          Effect.sync(() => {
            if (this.watchTimer) clearTimeout(this.watchTimer);
            this.watchHealthy = false;
            this.watcher?.close();
          }),
        ),
      );
    } catch {
      this.watchHealthy = false;
      this.watcher?.close();
      this.configError = visible(
        failure("ConfigIO", "The configuration directory could not be watched."),
      );
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.cancelValidation();
    this.closePromise = this.serial(async () => {
      try {
        this.lifetimeClosed ??= Effect.runPromise(Scope.close(this.lifetime, Exit.void));
        await Promise.all([this.stopOwned(), this.lifetimeClosed]);
      } finally {
        this.closed = true;
      }
    }).catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
}

export const open = (
  configPath: string,
  options: ControllerOptions = {},
): Promise<McpGatewayController> => McpGatewayController.open(configPath, options);
