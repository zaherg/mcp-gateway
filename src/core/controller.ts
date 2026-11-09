import { type FSWatcher, lstatSync, watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type ConfigDocument,
  ConfigStore,
  isHttpServer,
  parseConfig,
} from '@mcp-gateway/core/config';
import { failure, GatewayError, visible } from '@mcp-gateway/core/errors';
import { GatewayIngress } from '@mcp-gateway/core/ingress';
import { LogBuffer } from '@mcp-gateway/core/logs';
import {
  interfaceChoices,
  isSelfProxyCancelled,
  rejectSelfProxy,
  SELF_PROXY_DEADLINE_MS,
  type SelfProxyOptions,
  selectInterface,
} from '@mcp-gateway/core/network';
import { createSerialQueue } from '@mcp-gateway/core/serial-queue';
import type {
  GatewayConfig,
  GatewayController,
  GatewayOperation,
  GatewaySnapshot,
  LogQuery,
  VisibleError,
} from '@mcp-gateway/shared/types';

/** Local native/UI API. Snapshots contain explicit config credentials; do not log them. */
export class McpGatewayController implements GatewayController {
  private readonly queue = createSerialQueue();
  private readonly store: ConfigStore;
  private document: ConfigDocument = { text: '', revision: '' };
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
    this.logs.append({ server: null, level: 'error', source: 'controller' }, [
      'Local application operation failed:',
      error,
    ]);
  }

  private watcher: FSWatcher | undefined;
  private watchHealthy = false;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private closing = false;
  private validation = new AbortController();
  private closePromise: Promise<void> | undefined;
  private closeWatcher: (() => void) | undefined;
  private interfaceRecovery: ReturnType<typeof setInterval> | undefined;

  private constructor(configPath: string) {
    this.store = new ConfigStore(configPath);
  }

  static async open(configPath: string): Promise<McpGatewayController> {
    const controller = new McpGatewayController(configPath);
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
        controller.event('info', 'Configuration loaded.');
      } catch (error) {
        controller.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
        controller.configError = visible(error);
        controller.event('error', 'Configuration could not be loaded.');
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
          type: isHttpServer(server) ? ('http' as const) : ('stdio' as const),
          endpoint: `http://${config?.gateway.host}:${config?.gateway.port}/mcp/${name}`,
          enabled: !server.disabled,
          status: server.disabled ? ('disabled' as const) : ('stopped' as const),
          error: null,
        })),
      configError: this.configError ? { ...this.configError } : null,
      operationalError: this.operationalError ? { ...this.operationalError } : null,
    };
  }

  private event(level: 'info' | 'error', message: string): void {
    this.logs.append({ server: null, level, source: 'controller' }, [message]);
  }

  private serial<A>(work: () => Promise<A>): Promise<A> {
    return this.queue(async () => {
      try {
        return await work();
      } catch (error) {
        this.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
        throw error instanceof GatewayError
          ? error
          : failure('BackendFailure', 'The gateway operation failed.');
      }
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
      signal,
      deadline: Date.now() + SELF_PROXY_DEADLINE_MS,
    };
  }

  private cancelValidation(): void {
    this.validation.abort();
  }

  private ensureOpen(): void {
    if (this.closed || this.closing) throw failure('Closed', 'The controller is closed.');
  }

  private report = (error: VisibleError): void => {
    this.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
    this.operationalError = error;
    this.event('error', error.message);
  };

  private async startOwned(control: SelfProxyOptions): Promise<void> {
    this.ensureOpen();
    if (!this.watchHealthy)
      throw failure(
        'ConfigIO',
        'Configuration watching is unavailable; reopen the controller before starting.',
      );
    if (this.ingress?.running) return;
    // Read the authoritative bytes again, even if a watch notification is delayed.
    await this.refresh(control);
    if (!this.config || this.configError)
      throw failure('InvalidConfig', 'Correct the on-disk configuration before starting.');
    await this.stopOwned();
    const config = this.config;
    try {
      const ingress = await GatewayIngress.open(
        config,
        this.report,
        this.logs,
        control,
        this.awaitInterface,
      ).catch((error) => {
        throw error instanceof GatewayError
          ? error
          : failure('ListenerFailure', 'The listener could not start.');
      });
      this.closingIngress = ingress;
      this.ensureOpen();
      if (!this.watchHealthy)
        throw failure(
          'ConfigIO',
          'Configuration watching is unavailable; reopen the controller before starting.',
        );
      this.ingress = ingress;
      this.closingIngress = undefined;
      this.cancelInterfaceRecovery();
      this.operationalError = null;
      this.event('info', 'Gateway listener started; backends initialize on client requests.');
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
      if (this.operationalError?.code === 'ShutdownFailure') this.operationalError = null;
      this.event('info', 'Gateway listener stopped.');
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

  // The listener closes when its address disappears (fail closed). The user
  // still wants it running, so reopen it once the configured address returns.
  // A Stop or close aborts the captured lifetime and ends the wait.
  private awaitInterface = (lost: GatewayIngress): void => {
    if (this.closed || this.closing || (this.ingress !== lost && this.closingIngress !== lost))
      return;
    this.cancelInterfaceRecovery();
    const signal = this.validationLifetime();
    const timer = setInterval(() => {
      if (signal.aborted) {
        this.cancelInterfaceRecovery();
        return;
      }
      try {
        selectInterface(this.config?.gateway.host ?? '');
      } catch {
        return;
      }
      this.cancelInterfaceRecovery();
      void this.serial(async () => {
        if (signal.aborted || this.ingress?.running) return;
        await this.startOwned(this.control(signal));
        this.event('info', 'The selected interface returned; the gateway listener restarted.');
      }).catch((error) => {
        if (!isSelfProxyCancelled(error)) this.report(visible(error));
      });
    }, 1_000);
    timer.unref();
    this.interfaceRecovery = timer;
  };

  private cancelInterfaceRecovery(): void {
    if (this.interfaceRecovery) clearInterval(this.interfaceRecovery);
    this.interfaceRecovery = undefined;
  }

  stop(): Promise<GatewaySnapshot> {
    this.cancelValidation();
    this.cancelInterfaceRecovery();
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
        throw failure('BackendFailure', 'Start the gateway before restarting a server.');
      try {
        await this.ingress.restart(name, control);
        this.event('info', 'A backend endpoint was restarted.');
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
            'ConfigIO',
            'Configuration watching is unavailable; reopen the controller before starting.',
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
    const candidate = await this.validated(control);
    if (!candidate) return;
    // A valid document that cannot be applied (for example a busy port) is an
    // operational error; apply() reports it and stops the listener.
    await this.apply(candidate.document, candidate.config, control);
  }

  private async validated(
    control: SelfProxyOptions,
  ): Promise<{ document: ConfigDocument; config: GatewayConfig } | null> {
    let document: ConfigDocument | undefined;
    try {
      document = await this.store.read();
      if (document.revision === this.document.revision && !this.configError) return null;
      // Validate the candidate before publishing its text/revision. A cancelled
      // refresh must leave document/config consistent so the next Start retries it.
      const next = parseConfig(document.text, process.env, this.store.format);
      selectInterface(next.gateway.host);
      await rejectSelfProxy(next, control);
      return { document, config: next };
    } catch (error) {
      // A superseded operation leaves the authoritative config and configError alone.
      if (control.signal?.aborted || isSelfProxyCancelled(error)) throw error;
      // Invalid external source stays visible for repair, while the validated
      // config retains the last accepted state.
      if (document) this.document = document;
      this.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
      this.configError = visible(error);
      this.event('error', 'Invalid external configuration; listener stopped.');
      await this.stopOwned();
      return null;
    }
  }

  private failWatcher = (): void => {
    if (!this.watchHealthy || this.closed || this.closing) return;
    this.watchHealthy = false;
    void this.serial(async () => {
      this.configError = visible(
        failure(
          'ConfigIO',
          'Configuration watching is unavailable; reopen the controller before starting.',
        ),
      );
      await this.stopOwned();
    }).catch((error) => this.report(visible(error)));
  };

  private observe(): void {
    try {
      const identity = lstatSync(dirname(this.store.path));
      if (!identity.isDirectory() || identity.isSymbolicLink())
        throw failure('UnsafeFile', 'The configuration directory is unsafe.');
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
      this.watcher.on('error', this.failWatcher);
      this.watcher.on('close', this.failWatcher);
      this.closeWatcher = () => {
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchHealthy = false;
        this.watcher?.close();
      };
    } catch {
      this.watchHealthy = false;
      this.watcher?.close();
      this.configError = visible(
        failure('ConfigIO', 'The configuration directory could not be watched.'),
      );
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.cancelValidation();
    this.cancelInterfaceRecovery();
    this.closePromise = this.serial(async () => {
      try {
        this.closeWatcher?.();
        this.closeWatcher = undefined;
        await this.stopOwned();
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
