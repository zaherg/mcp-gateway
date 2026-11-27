import { randomBytes, randomUUID } from 'node:crypto';
import { type FSWatcher, lstatSync, watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type ConfigDocument,
  ConfigStore,
  isHttpServer,
  keyRefs,
  literalKeySlots,
  parseConfigWithSlots,
  resolveKeys,
} from '@mcp-gateway/core/config';
import { failure, GatewayError, visible } from '@mcp-gateway/core/errors';
import { GatewayIngress, type PreventIdleSleep } from '@mcp-gateway/core/ingress';
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
import {
  type ConfigFormat,
  editConfigDocument,
  isRecord,
  parseConfigDocument,
} from '@mcp-gateway/shared/config-document';
import type {
  GatewayConfig,
  GatewayController,
  GatewayOperation,
  KeyMigration,
  KeyStore,
  LogQuery,
  VisibleError,
} from '@mcp-gateway/shared/types';

const WATCH_UNAVAILABLE =
  'Configuration watching is unavailable; reopen the controller before starting.';

const createKeyRef = async (keys: KeyStore, token: string) => {
  const ref = randomUUID();
  await keys.set(ref, token);
  if ((await keys.get([ref])).get(ref) !== token)
    throw failure('ConfigIO', 'A key could not be stored in Keychain.');
  return ref;
};

// Resolved mode: the only parse that reads Keychain, once per load and within one deadline.
const resolveGatewayKeys = async (
  text: string,
  format: ConfigFormat,
  keys: KeyStore | undefined,
) => {
  const { file, slots } = parseConfigWithSlots(text, process.env, format);
  const refs = keyRefs(file);
  if (refs.length === 0) return { config: resolveKeys(file, new Map()), slots };
  if (!keys)
    throw failure(
      'KeyUnavailable',
      'Keys stored in Keychain need the signed MCP Gateway app. Generate a new key to use this build.',
    );
  return { config: resolveKeys(file, await keys.get(refs)), slots };
};

const performKeyMigration = async (
  document: ConfigDocument,
  format: ConfigFormat,
  keys: KeyStore,
  slots: KeyMigration,
  eligible: KeyMigration,
  expectedRevision: string,
) => {
  if (expectedRevision !== document.revision)
    throw failure('StaleRevision', 'Configuration changed on disk; review the keys again.');
  if (
    (!slots.gateway && slots.servers.length === 0) ||
    (slots.gateway && !eligible.gateway) ||
    slots.servers.some((name) => !eligible.servers.includes(name))
  )
    throw failure('InvalidConfig', 'These keys can no longer be moved; review them again.');
  const file = parseConfigDocument(document.text, format);
  if (!isRecord(file) || !isRecord(file.mcpServers))
    throw failure('InvalidConfig', 'Configuration does not match the supported schema.');
  const servers = file.mcpServers;
  const chosen = [
    ...(slots.gateway ? [file.gateway] : []),
    ...slots.servers.map((name) => servers[name]),
  ];
  // Every item is created and read back before the file changes. A failure leaves the file
  // as it was; created items stay as unused copies because the app never deletes one.
  for (const slot of chosen) {
    if (!isRecord(slot) || typeof slot.token !== 'string')
      throw failure('InvalidConfig', 'These keys can no longer be moved; review them again.');
    slot.tokenRef = await createKeyRef(keys, slot.token);
    delete slot.token;
  }
  return editConfigDocument(document.text, file, format);
};

class KeySlotCache {
  private revision = '';
  private slots: KeyMigration = { gateway: false, servers: [] };

  record(revision: string, slots: KeyMigration) {
    this.revision = revision;
    this.slots = slots;
  }

  eligible(document: ConfigDocument, format: ConfigFormat, enabled: boolean) {
    if (!enabled) return { gateway: false, servers: [] };
    if (this.revision !== document.revision) {
      this.revision = document.revision;
      this.slots = literalKeySlots(document.text, format);
    }
    return { gateway: this.slots.gateway, servers: [...this.slots.servers] };
  }
}

class ConfigDirectoryWatch {
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  healthy = false;

  constructor(
    private readonly directory: string,
    private readonly isInactive: () => boolean,
    private readonly captureLifetime: () => AbortSignal,
    private readonly onChanged: (signal: AbortSignal, verify: () => Promise<boolean>) => void,
    private readonly onFailed: () => void,
  ) {}

  start() {
    try {
      const identity = lstatSync(this.directory);
      if (!identity.isDirectory() || identity.isSymbolicLink())
        throw failure('UnsafeFile', 'The configuration directory is unsafe.');
      const verify = async () => {
        try {
          const current = await lstat(this.directory);
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.dev !== identity.dev ||
            current.ino !== identity.ino
          ) {
            this.fail();
            return false;
          }
          return true;
        } catch {
          this.fail();
          return false;
        }
      };
      this.watcher = watch(this.directory, () => {
        if (this.isInactive() || !this.healthy) return;
        // Capture cancellation ownership when the event is admitted, before the
        // debounce and controller queue. A Stop that arrives while this event
        // waits must cancel it instead of letting it start a fresh lifetime.
        const signal = this.captureLifetime();
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.onChanged(signal, verify);
        }, 20);
      });
      this.healthy = true;
      this.watcher.on('error', this.fail);
      this.watcher.on('close', this.fail);
      return null;
    } catch {
      this.healthy = false;
      this.watcher?.close();
      return visible(failure('ConfigIO', 'The configuration directory could not be watched.'));
    }
  }

  private fail = () => {
    if (!this.healthy || this.isInactive()) return;
    this.healthy = false;
    this.onFailed();
  };

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.healthy = false;
    this.watcher?.close();
    this.watcher = undefined;
  }
}

/** Local native/UI API. Snapshots contain explicit config credentials; do not log them. */
export class McpGatewayController implements GatewayController {
  private readonly queue = createSerialQueue();
  private readonly store: ConfigStore;
  private readonly keySlots = new KeySlotCache();
  private readonly directoryWatch: ConfigDirectoryWatch;
  private document: ConfigDocument = { text: '', revision: '' };
  private config: GatewayConfig | undefined;
  private ingress: GatewayIngress | undefined;
  // The lifetime the running listener was started with; Stop aborts it.
  private ingressSignal: AbortSignal | undefined;
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
  recordLocalError(error: unknown) {
    this.logs.append({ server: null, level: 'error', source: 'controller' }, [
      'Local application operation failed:',
      error,
    ]);
  }

  private closed = false;
  private closing = false;
  private validation = new AbortController();
  private closePromise: Promise<void> | undefined;
  private interfaceRecovery: ReturnType<typeof setInterval> | undefined;

  private constructor(
    configPath: string,
    private readonly preventIdleSleep?: PreventIdleSleep,
    // Development builds pass none: their items would be unreadable by the signed app.
    private readonly keys?: KeyStore,
  ) {
    this.store = new ConfigStore(configPath);
    this.directoryWatch = new ConfigDirectoryWatch(
      dirname(this.store.path),
      () => this.closed || this.closing,
      () => this.validationLifetime(),
      (signal, verify) => {
        void this.cancellable(signal, async (control) => {
          if (this.closed || this.closing || !this.directoryWatch.healthy) return;
          if (!(await verify())) return;
          await this.refresh(control);
        }).catch((error) => {
          if (!isSelfProxyCancelled(error)) this.report(visible(error));
        });
      },
      () => {
        void this.serial(async () => {
          this.configError = visible(this.watchFailure());
          await this.stopOwned();
        }).catch((error) => this.report(visible(error)));
      },
    );
  }

  static async open(
    configPath: string,
    preventIdleSleep: PreventIdleSleep | undefined,
    keys: KeyStore | undefined,
    port: number,
  ) {
    const controller = new McpGatewayController(configPath, preventIdleSleep, keys);
    await controller.cancellable(controller.validationLifetime(), async (control) => {
      try {
        controller.document = await controller.store.initialize(async () => {
          const token = randomBytes(32).toString('hex');
          if (!keys) return { port, token };
          try {
            return { port, tokenRef: await createKeyRef(keys, token) };
          } catch (error) {
            // Keep the store or read-back reason in Logs; the visible error gives the remedy.
            controller.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
            throw failure(
              'KeySetupFailed',
              'The first gateway key could not be stored in Keychain. Unlock Keychain, allow access, and reopen the app.',
            );
          }
        });
        const parsed = await controller.parse(controller.document.text);
        controller.config = await controller.validate(parsed.config, control);
        controller.keySlots.record(controller.document.revision, parsed.slots);
        controller.event('info', 'Configuration loaded.');
      } catch (error) {
        controller.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
        controller.configError = visible(error);
        controller.event('error', 'Configuration could not be loaded.');
        // No file exists to watch; preference writes must not replace the setup error.
        if (controller.configError.code === 'KeySetupFailed') return;
      }
      const watchError = controller.directoryWatch.start();
      if (watchError) controller.configError = watchError;
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

  snapshot() {
    const config = this.config;
    const running = this.ingress?.running ?? false;
    const interfaces = interfaceChoices();
    return {
      configPath: this.store.path,
      configFormat: this.store.format,
      configText: this.document.text,
      revision: this.document.revision,
      running,
      interfaces,
      network: interfaces.find((entry) => entry.address === config?.gateway.host)?.kind ?? null,
      keyMigration: this.keyMigration(),
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

  activeConfig() {
    return this.config;
  }

  private parse(text: string) {
    return resolveGatewayKeys(text, this.store.format, this.keys);
  }

  private keyMigration() {
    return this.keySlots.eligible(
      this.document,
      this.store.format,
      Boolean(this.keys && this.config && !this.configError),
    );
  }

  private async validate(config: GatewayConfig, control: SelfProxyOptions) {
    selectInterface(config.gateway.host);
    await rejectSelfProxy(config, control);
    return config;
  }

  private event(level: 'info' | 'error', message: string) {
    this.logs.append({ server: null, level, source: 'controller' }, [message]);
  }

  private serial<A>(work: () => Promise<A>) {
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
  private validationLifetime() {
    if (this.validation.signal.aborted) this.validation = new AbortController();
    return this.validation.signal;
  }

  operation() {
    return { signal: this.validationLifetime() };
  }

  // An explicitly captured operation keeps the lifetime it was requested with;
  // only calls without one capture a fresh lifetime now.
  private operationSignal(operation?: GatewayOperation) {
    return operation?.signal ?? this.validationLifetime();
  }

  // Queued work runs under the lifetime captured when it was requested. A Stop requested
  // after it aborts that lifetime, so the work refuses at dequeue, before any side effect.
  // The deadline bounds validation, not time spent waiting for the queue.
  private cancellable<A>(signal: AbortSignal, work: (control: SelfProxyOptions) => Promise<A>) {
    return this.serial(async () => {
      if (signal.aborted)
        throw failure('Cancelled', 'The request was cancelled because the gateway stopped.');
      return work({ signal, deadline: Date.now() + SELF_PROXY_DEADLINE_MS });
    });
  }

  private cancelValidation() {
    this.validation.abort();
  }

  private ensureOpen() {
    if (this.closed || this.closing) throw failure('Closed', 'The controller is closed.');
  }

  private watchFailure() {
    return failure('ConfigIO', WATCH_UNAVAILABLE);
  }

  private requireWatchHealthy() {
    if (!this.directoryWatch.healthy) throw this.watchFailure();
  }

  private report = (error: VisibleError) => {
    this.logs.append({ server: null, level: 'error', source: 'controller' }, [error]);
    this.operationalError = error;
    this.event('error', error.message);
  };

  private async startOwned(control: SelfProxyOptions) {
    this.ensureOpen();
    this.requireWatchHealthy();
    if (this.ingress?.running) return;
    // Read the authoritative bytes again, even if a watch notification is delayed.
    await this.refresh(control);
    // A still-unreadable key reports its own reason instead of asking to correct the file.
    if (this.configError?.code === 'KeyUnavailable') throw new GatewayError(this.configError);
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
        this.preventIdleSleep,
      ).catch((error) => {
        throw error instanceof GatewayError
          ? error
          : failure('ListenerFailure', 'The listener could not start.');
      });
      this.closingIngress = ingress;
      this.ensureOpen();
      this.requireWatchHealthy();
      this.ingress = ingress;
      this.ingressSignal = control.signal;
      this.closingIngress = undefined;
      this.cancelInterfaceRecovery();
      this.operationalError = null;
      this.event('info', 'Gateway listener started; backends initialize on client requests.');
    } catch (error) {
      await this.stopOwned();
      throw error;
    }
  }

  private async stopOwned() {
    const ingress = this.ingress ?? this.closingIngress;
    this.ingress = undefined;
    this.ingressSignal = undefined;
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

  start(operation?: GatewayOperation) {
    return this.cancellable(this.operationSignal(operation), async (control) => {
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
  // A Stop or close aborts the listener's lifetime and ends the wait. A fresh lifetime
  // must not be taken here: it would outlive a Stop that is still waiting in the queue.
  private awaitInterface = (lost: GatewayIngress) => {
    const signal = this.ingressSignal;
    if (this.closed || this.closing || this.ingress !== lost || !signal || signal.aborted) return;
    this.cancelInterfaceRecovery();
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
      void this.cancellable(signal, async (control) => {
        if (this.ingress?.running) return;
        await this.startOwned(control);
        this.event('info', 'The selected interface returned; the gateway listener restarted.');
      }).catch((error) => {
        if (!isSelfProxyCancelled(error)) this.report(visible(error));
      });
    }, 1_000);
    timer.unref();
    this.interfaceRecovery = timer;
  };

  private cancelInterfaceRecovery() {
    if (this.interfaceRecovery) clearInterval(this.interfaceRecovery);
    this.interfaceRecovery = undefined;
  }

  stop() {
    this.cancelValidation();
    this.cancelInterfaceRecovery();
    return this.serial(async () => {
      this.ensureOpen();
      await this.stopOwned();
      return this.snapshot();
    });
  }

  restartServer(name: string, operation?: GatewayOperation) {
    return this.cancellable(this.operationSignal(operation), async (control) => {
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

  // Not queued: Stop, a reload or a save must not wait behind a slow backend. Stop and
  // reconciliation reach the test through the ingress, which aborts it.
  async testServer(name: string, expectedRevision: string) {
    this.ensureOpen();
    this.requireWatchHealthy();
    if (expectedRevision !== this.document.revision)
      throw failure('StaleRevision', 'The configuration changed. Test again after it reloads.');
    if (this.configError)
      throw failure('InvalidConfig', 'Repair the configuration before testing a server.');
    if (!this.ingress?.running)
      throw failure('Closed', 'Start the gateway before testing a server.');
    return this.ingress.testServer(name);
  }

  saveConfig(text: string, expectedRevision: string, operation?: GatewayOperation) {
    return this.cancellable(this.operationSignal(operation), async (control) => {
      this.ensureOpen();
      // No file exists yet; a failed save would replace the setup remedy with a generic error.
      if (this.configError?.code === 'KeySetupFailed') throw new GatewayError(this.configError);
      const parsed = await this.parse(text);
      const next = await this.validate(parsed.config, control);
      const document = await this.store.save(text, expectedRevision, true).catch(async (error) => {
        await this.refresh(control);
        throw error;
      });
      this.keySlots.record(document.revision, parsed.slots);
      await this.apply(document, next, control);
      return this.snapshot();
    });
  }

  migrateKeys(slots: KeyMigration, expectedRevision: string, operation?: GatewayOperation) {
    return this.cancellable(this.operationSignal(operation), async (control) => {
      this.ensureOpen();
      if (!this.keys || !this.config)
        throw failure('InvalidConfig', 'Keys can move to Keychain only in the signed app.');
      const text = await performKeyMigration(
        this.document,
        this.store.format,
        this.keys,
        slots,
        this.keyMigration(),
        expectedRevision,
      );
      const document = await this.store.save(text, expectedRevision).catch(async (error) => {
        await this.refresh(control);
        throw error;
      });
      // Same keys, new references: no fingerprint or listener setting changes, so open
      // sessions continue and nothing is read back from Keychain.
      await this.apply(document, this.config, control);
      this.event('info', 'Keys were moved to Keychain.');
      return this.snapshot();
    });
  }

  private async apply(document: ConfigDocument, next: GatewayConfig, control: SelfProxyOptions) {
    const previous = this.config;
    const running = this.ingress?.running ?? false;
    this.document = document;
    this.config = next;
    this.configError = this.directoryWatch.healthy ? null : visible(this.watchFailure());
    if (!running) return;
    try {
      if (
        previous?.gateway.host !== next.gateway.host ||
        previous?.gateway.port !== next.gateway.port ||
        previous?.gateway.token !== next.gateway.token ||
        // Narrowed ranges must also end streams and sessions opened by excluded peers.
        JSON.stringify(previous?.gateway.allowedPeers) !== JSON.stringify(next.gateway.allowedPeers)
      ) {
        await this.stopOwned();
        await this.startOwned(control);
      } else await this.ingress?.reconcile(next, control);
    } catch (error) {
      // The document is already accepted, so a failure to apply it is the gateway's error,
      // not the caller's: a save must not report a file it wrote as unsaved.
      this.report(visible(error));
      // stopOwned reports its own failure and keeps the listener owned for the next Stop.
      await this.stopOwned().catch(() => undefined);
    }
  }

  private async refresh(control: SelfProxyOptions) {
    const candidate = await this.validated(control);
    if (!candidate) return;
    // A valid document that cannot be applied (for example a busy port) is an
    // operational error; apply() reports it and stops the listener.
    this.keySlots.record(candidate.document.revision, candidate.slots);
    await this.apply(candidate.document, candidate.config, control);
  }

  private async validated(control: SelfProxyOptions) {
    let document: ConfigDocument | undefined;
    try {
      document = await this.store.read();
      if (document.revision === this.document.revision && !this.configError) return null;
      // Validate the candidate before publishing its text/revision. A cancelled
      // refresh must leave document/config consistent so the next Start retries it.
      const parsed = await this.parse(document.text);
      const next = await this.validate(parsed.config, control);
      return { document, config: next, slots: parsed.slots };
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

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.cancelValidation();
    this.cancelInterfaceRecovery();
    this.closePromise = this.serial(async () => {
      try {
        this.directoryWatch.close();
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
