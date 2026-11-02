import { type FSWatcher, lstatSync, watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Exit, Result, Scope, Semaphore } from "effect";
import type { LogQuery } from "../shared/logs";
import type {
  GatewayConfig,
  GatewayController,
  GatewayEvent,
  GatewaySnapshot,
  VisibleError,
} from "../shared/types";
import { isHttpServer, parseConfig } from "./config";
import { type ConfigDocument, ConfigStore } from "./config-store";
import { failure, operational, visible } from "./errors";
import { GatewayIngress } from "./ingress";
import { LogBuffer } from "./logs";
import { interfaceChoices, rejectSelfProxy, selectInterface } from "./network";

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
  private closePromise: Promise<void> | undefined;
  private lifetimeClosed: Promise<void> | undefined;

  private constructor(configPath: string) {
    this.store = new ConfigStore(configPath);
  }

  static async open(configPath: string): Promise<McpGatewayController> {
    const controller = new McpGatewayController(configPath);
    await controller.serial(async () => {
      try {
        controller.document = await controller.store.initialize();
        controller.config = parseConfig(
          controller.document.text,
          process.env,
          controller.store.format,
        );
        selectInterface(controller.config.gateway.host);
        await rejectSelfProxy(controller.config);
        controller.event("info", "Configuration loaded.");
      } catch (error) {
        controller.logs.append({ server: null, level: "error", source: "controller" }, [error]);
        controller.configError = visible(error);
        controller.event("error", "Configuration could not be loaded.");
      }
      controller.observe();
      if (controller.config?.gateway.autoStart && !controller.configError) {
        try {
          await controller.startOwned();
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
        this.ingress?.snapshots() ??
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

  private ensureOpen(): void {
    if (this.closed || this.closing) throw failure("Closed", "The controller is closed.");
  }

  private report = (error: VisibleError): void => {
    this.logs.append({ server: null, level: "error", source: "controller" }, [error]);
    this.operationalError = error;
    this.event("error", error.message);
  };

  private async startOwned(): Promise<void> {
    this.ensureOpen();
    if (!this.watchHealthy)
      throw failure(
        "ConfigIO",
        "Configuration watching is unavailable; reopen the controller before starting.",
      );
    if (this.ingress?.running) return;
    // Read the authoritative bytes again, even if a watch notification is delayed.
    await this.refresh();
    if (!this.config || this.configError)
      throw failure("InvalidConfig", "Correct the on-disk configuration before starting.");
    await this.stopOwned();
    const config = this.config;
    try {
      const ingress = await Effect.runPromise(
        operational(
          () => GatewayIngress.open(config, this.report, this.logs),
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

  start(): Promise<GatewaySnapshot> {
    return this.serial(async () => {
      try {
        await this.startOwned();
        return this.snapshot();
      } catch (error) {
        this.report(visible(error));
        throw error;
      }
    });
  }

  stop(): Promise<GatewaySnapshot> {
    return this.serial(async () => {
      this.ensureOpen();
      await this.stopOwned();
      return this.snapshot();
    });
  }

  restartServer(name: string): Promise<GatewaySnapshot> {
    return this.serial(async () => {
      this.ensureOpen();
      if (!this.ingress?.running)
        throw failure("BackendFailure", "Start the gateway before restarting a server.");
      try {
        await this.ingress.restart(name);
        this.event("info", "A backend endpoint was restarted.");
      } catch (error) {
        this.report(visible(error));
        throw error;
      }
      return this.snapshot();
    });
  }

  saveConfig(text: string, expectedRevision: string): Promise<GatewaySnapshot> {
    return this.serial(async () => {
      this.ensureOpen();
      const next = parseConfig(text, process.env, this.store.format);
      selectInterface(next.gateway.host);
      await rejectSelfProxy(next);
      const document = await this.store.save(text, expectedRevision).catch(async (error) => {
        await this.refresh();
        throw error;
      });
      await this.apply(document, next);
      return this.snapshot();
    });
  }

  private async apply(document: ConfigDocument, next: GatewayConfig): Promise<void> {
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
        await this.startOwned();
      } else await this.ingress?.reconcile(next);
    } catch (error) {
      this.report(visible(error));
      await this.stopOwned();
      throw error;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const document = await this.store.read();
      if (document.revision === this.document.revision && !this.configError) return;
      this.document = document;
      const next = parseConfig(document.text, process.env, this.store.format);
      selectInterface(next.gateway.host);
      await rejectSelfProxy(next);
      await this.apply(document, next);
    } catch (error) {
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
            await this.refresh();
          }).catch((error) => this.report(visible(error)));
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

export const open = (configPath: string): Promise<McpGatewayController> =>
  McpGatewayController.open(configPath);
