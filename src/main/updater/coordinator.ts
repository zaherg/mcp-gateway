import type { QuitStatus, UpdateStatus } from "../../shared/rpc";
import {
  type PreparedUpdateAttempt,
  UpdateBoundaryError,
  type UpdateCheckResult,
} from "./boundary";
import { type FrozenCandidate, isHigherStableVersion } from "./candidate";
import type { ApplySettlement } from "./handoff";
import {
  loadUpdatePreferences,
  saveUpdatePreferences,
  type UpdatePreferencesState,
} from "./preferences";
import type { UpdateAttempt } from "./transaction";

const DEFAULT_STARTUP_DELAY_MS = 10_000;
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 60_000;

export type UpdatePolicyErrorCode =
  | "UpdateUnsupported"
  | "UpdateNotReady"
  | "UpdateBusy"
  | "UpdatePreference"
  | "UpdateInstallationDisabled"
  | "UpdateRecoveryRequired"
  | "UpdateShutdown";

export class UpdatePolicyError extends Error {
  readonly code: UpdatePolicyErrorCode;

  constructor(code: UpdatePolicyErrorCode) {
    const messages: Record<UpdatePolicyErrorCode, string> = {
      UpdateUnsupported: "Automatic updates are unavailable in this build.",
      UpdateNotReady: "No verified update is ready to install.",
      UpdateBusy: "Another update operation is already in progress.",
      UpdatePreference: "The update preference could not be changed.",
      UpdateInstallationDisabled: "Update installation is not enabled in this build.",
      UpdateRecoveryRequired: "A previous update needs recovery before new update work can start.",
      UpdateShutdown: "Update work is unavailable after shutdown has started.",
    };
    super(messages[code]);
    this.name = "UpdatePolicyError";
    this.code = code;
  }
}

export interface UpdateRuntime {
  checkForUpdate(): Promise<UpdateCheckResult>;
  prepareUpdateAttempt(): Promise<PreparedUpdateAttempt>;
  revalidate(candidate: FrozenCandidate, signal?: AbortSignal): Promise<unknown>;
  reconcile?(): Promise<{
    status: "none" | "confirmed" | "failed" | "unconfirmed" | "recovery-required";
    recoveryPath?: string;
    version?: string;
    hash?: string;
    message?: string;
  }>;
  abandonPrepared?(): Promise<void>;
  cancel?(): void;
}

export interface UpdateTerminal {
  reserveUpdate(candidate: FrozenCandidate): UpdateAttempt | undefined;
  requestRestartToUpdate(attempt: UpdateAttempt): {
    accepted: boolean;
    status: QuitStatus;
  };
  cancelUpdate(attemptId: number): void;
}

export interface UpdaterTimers {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
  now(): number;
}

const systemTimers: UpdaterTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle),
  now: () => Date.now(),
};

export interface UpdaterCoordinatorOptions {
  dataDirectory: string;
  supported: boolean;
  installationEnabled?: boolean;
  installedVersion: string | null;
  runtime?: UpdateRuntime;
  terminal?: UpdateTerminal;
  timers?: UpdaterTimers;
  startupDelayMs?: number;
  checkIntervalMs?: number;
  pollIntervalMs?: number;
}

export class UpdaterCoordinator {
  private readonly dataDirectory: string;
  private readonly runtime: UpdateRuntime | undefined;
  private readonly terminal: UpdateTerminal | undefined;
  private readonly installationEnabled: boolean;
  private readonly timers: UpdaterTimers;
  private readonly startupDelayMs: number;
  private readonly checkIntervalMs: number;
  private readonly pollIntervalMs: number;
  private preferences: UpdatePreferencesState = {
    automaticUpdates: false,
    status: "default",
    error: null,
  };
  private status: UpdateStatus;
  private candidate: FrozenCandidate | undefined;
  private checkOperation: Promise<UpdateStatus> | undefined;
  private prepareOperation: Promise<UpdateStatus> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private lastCheckAt = 0;
  private generation = 0;
  private stopped = false;
  private reserved: UpdateAttempt | undefined;
  private restartOperation: { id: number; promise: Promise<QuitStatus> } | undefined;
  private initialized = false;
  private initialization: Promise<UpdateStatus> | undefined;

  constructor(options: UpdaterCoordinatorOptions) {
    this.dataDirectory = options.dataDirectory;
    this.runtime = options.runtime;
    this.terminal = options.terminal;
    this.installationEnabled = options.installationEnabled ?? false;
    this.timers = options.timers ?? systemTimers;
    this.startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.status = {
      supported: options.supported,
      installationEnabled: options.supported && (options.installationEnabled ?? false),
      automaticUpdates: false,
      installedVersion: options.installedVersion,
      availableVersion: null,
      availableHash: null,
      readyVersion: null,
      phase: options.supported ? "idle" : "unsupported",
      error: null,
      preferenceError: null,
      recoveryRequired: false,
      recoveryPath: null,
      checkedAt: null,
      attemptId: null,
      transaction: null,
    };
  }

  async start(options: { reconcile?: boolean } = {}): Promise<UpdateStatus> {
    if (!this.status.supported || this.stopped) return this.statusValue();
    const shouldReconcile = options.reconcile !== false;
    this.initialized = false;
    if (shouldReconcile) await this.completeInitialization();
    try {
      this.preferences = await loadUpdatePreferences(this.dataDirectory);
    } catch {
      this.preferences = {
        automaticUpdates: false,
        status: "invalid",
        error: "Update preferences could not be read. Background updates are disabled.",
      };
    }
    if (this.stopped) return this.statusValue();
    this.status = {
      ...this.status,
      automaticUpdates: this.preferences.automaticUpdates,
      phase:
        this.status.phase === "error"
          ? "error"
          : this.preferences.status === "invalid"
            ? "preference-error"
            : "idle",
      preferenceError: this.preferences.error,
    };
    if (
      this.initialized &&
      this.status.automaticUpdates &&
      !this.status.recoveryRequired &&
      this.status.phase !== "error"
    )
      this.scheduleChecks();
    return this.statusValue();
  }

  /** Production startup: reconcile only after initialization is complete. */
  completeInitialization(): Promise<UpdateStatus> {
    if (!this.status.supported || this.stopped || this.initialized)
      return Promise.resolve(this.statusValue());
    this.initialization ??= this.finishInitialization();
    return this.initialization;
  }

  private async finishInitialization(): Promise<UpdateStatus> {
    await this.reconcileNow();
    if (this.stopped) return this.statusValue();
    this.initialized = true;
    if (
      this.status.automaticUpdates &&
      !this.status.recoveryRequired &&
      this.status.phase !== "error"
    )
      this.scheduleChecks();
    return this.statusValue();
  }

  private async reconcileNow(): Promise<void> {
    try {
      const reconciliation = await this.runtime?.reconcile?.();
      if (reconciliation && reconciliation.status !== "none") {
        this.status = {
          ...this.status,
          phase: reconciliation.status === "confirmed" ? "idle" : "error",
          error:
            reconciliation.status === "confirmed"
              ? null
              : (reconciliation.message ?? "The previous update could not be confirmed."),
          recoveryRequired: reconciliation.status === "recovery-required",
          recoveryPath: reconciliation.recoveryPath ?? null,
          availableVersion: null,
          availableHash: null,
          readyVersion: null,
          transaction: {
            status: reconciliation.status,
            version: reconciliation.version ?? null,
            hash: reconciliation.hash ?? null,
            message: reconciliation.message ?? null,
          },
        };
      }
    } catch {
      this.status = {
        ...this.status,
        phase: "error",
        error: "The previous update transaction could not be reconciled safely.",
        recoveryRequired: true,
        transaction: {
          status: "recovery-required",
          version: null,
          hash: null,
          message: "The previous update transaction could not be reconciled safely.",
        },
      };
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.startupTimer) this.timers.clearTimeout(this.startupTimer);
    if (this.intervalTimer) this.timers.clearInterval(this.intervalTimer);
    this.startupTimer = undefined;
    this.intervalTimer = undefined;
    this.runtime?.cancel?.();
  }

  statusValue(): UpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<UpdateStatus> {
    if (!this.status.supported || !this.runtime) throw new UpdatePolicyError("UpdateUnsupported");
    if (this.stopped) throw new UpdatePolicyError("UpdateShutdown");
    if (!this.initialized) throw new UpdatePolicyError("UpdateBusy");
    if (this.status.recoveryRequired) throw new UpdatePolicyError("UpdateRecoveryRequired");
    if (this.status.phase === "restarting" || this.reserved)
      throw new UpdatePolicyError("UpdateBusy");
    if (this.checkOperation) return this.checkOperation;
    if (this.prepareOperation || this.status.phase === "ready") return this.statusValue();
    const operation = this.performCheck();
    this.checkOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.checkOperation === operation) this.checkOperation = undefined;
    }
  }

  async download(): Promise<UpdateStatus> {
    if (!this.status.supported || !this.runtime) throw new UpdatePolicyError("UpdateUnsupported");
    if (this.stopped) throw new UpdatePolicyError("UpdateShutdown");
    if (!this.initialized) throw new UpdatePolicyError("UpdateBusy");
    if (this.status.recoveryRequired) throw new UpdatePolicyError("UpdateRecoveryRequired");
    if (this.status.phase === "restarting" || this.reserved)
      throw new UpdatePolicyError("UpdateBusy");
    if (this.prepareOperation) return this.prepareOperation;
    if (this.checkOperation) throw new UpdatePolicyError("UpdateBusy");
    if (this.status.phase === "ready") return this.statusValue();
    if (!this.status.availableVersion || !this.status.availableHash)
      throw new UpdatePolicyError("UpdateNotReady");
    return this.startDownloadOperation();
  }

  private startDownloadOperation(): Promise<UpdateStatus> {
    if (this.prepareOperation) return this.prepareOperation;
    const operation = this.performDownload();
    this.prepareOperation = operation;
    return operation.finally(() => {
      if (this.prepareOperation === operation) this.prepareOperation = undefined;
    });
  }

  async setAutomatic(enabled: boolean): Promise<UpdateStatus> {
    if (!this.status.supported) throw new UpdatePolicyError("UpdateUnsupported");
    const next = await saveUpdatePreferences(this.dataDirectory, enabled, this.preferences);
    this.preferences = next;
    if (next.status === "write-failed") {
      this.status = {
        ...this.status,
        automaticUpdates: next.automaticUpdates,
        preferenceError: next.error,
      };
      return this.statusValue();
    }
    this.status = {
      ...this.status,
      automaticUpdates: next.automaticUpdates,
      preferenceError: next.error,
      phase:
        next.status === "invalid"
          ? "preference-error"
          : this.status.phase === "preference-error"
            ? "idle"
            : this.status.phase,
    };
    if (next.automaticUpdates && this.initialized) this.scheduleChecks();
    else this.clearTimers();
    return this.statusValue();
  }

  beginRestart(version: string, hash: string): UpdateAttempt {
    if (!this.status.supported || !this.installationEnabled)
      throw new UpdatePolicyError("UpdateUnsupported");
    if (!this.terminal) throw new UpdatePolicyError("UpdateUnsupported");
    const candidate = this.candidate;
    if (
      !candidate ||
      this.status.readyVersion !== version ||
      candidate.version !== version ||
      candidate.hash !== hash ||
      (this.status.phase !== "ready" &&
        this.status.phase !== "error" &&
        this.status.phase !== "restarting")
    )
      throw new UpdatePolicyError("UpdateNotReady");
    if (this.reserved) {
      if (this.reserved.candidate.version === version && this.reserved.candidate.hash === hash)
        return this.reserved;
      throw new UpdatePolicyError("UpdateBusy");
    }
    if (this.status.phase === "restarting") throw new UpdatePolicyError("UpdateBusy");
    const attempt = this.terminal.reserveUpdate(candidate);
    if (!attempt) throw new UpdatePolicyError("UpdateBusy");
    this.reserved = attempt;
    this.status = {
      ...this.status,
      phase: "restarting",
      error: null,
      attemptId: attempt.id,
    };
    return attempt;
  }

  async restartToUpdate(
    version: string,
    hash: string,
    admittedAttempt?: UpdateAttempt,
  ): Promise<QuitStatus> {
    if (!this.status.supported || !this.runtime) throw new UpdatePolicyError("UpdateUnsupported");
    if (!this.installationEnabled) throw new UpdatePolicyError("UpdateInstallationDisabled");
    if (!this.terminal) throw new UpdatePolicyError("UpdateUnsupported");
    const candidate = this.candidate;
    if (
      !candidate ||
      this.status.readyVersion !== version ||
      candidate.version !== version ||
      candidate.hash !== hash ||
      (this.status.phase !== "ready" &&
        this.status.phase !== "error" &&
        this.status.phase !== "restarting")
    )
      throw new UpdatePolicyError("UpdateNotReady");
    const attempt = admittedAttempt ?? this.reserved ?? this.beginRestart(version, hash);
    if (admittedAttempt && this.reserved !== admittedAttempt)
      throw new UpdatePolicyError("UpdateBusy");
    if (
      attempt.candidate.version !== version ||
      candidate.hash !== attempt.candidate.hash ||
      attempt.signal.aborted
    )
      throw new UpdatePolicyError("UpdateBusy");
    if (this.restartOperation?.id === attempt.id) return this.restartOperation.promise;
    const promise = this.performRestart(attempt, candidate);
    this.restartOperation = { id: attempt.id, promise };
    return promise;
  }

  private async performRestart(
    attempt: UpdateAttempt,
    candidate: FrozenCandidate,
  ): Promise<QuitStatus> {
    if (!this.runtime || !this.terminal) throw new UpdatePolicyError("UpdateUnsupported");
    this.status = {
      ...this.status,
      phase: "restarting",
      error: null,
      attemptId: attempt.id,
    };
    try {
      await this.runtime.revalidate(candidate, attempt.signal);
    } catch (error) {
      this.clearRestartReservation();
      this.status = {
        ...this.status,
        phase: "error",
        error: sanitizedUpdateError(error),
      };
      throw new UpdatePolicyError("UpdateNotReady");
    }
    const handoff = this.terminal.requestRestartToUpdate(attempt);
    if (!handoff.accepted) {
      this.clearRestartReservation();
      this.status = {
        ...this.status,
        phase: "error",
        error: "The update restart is already in progress.",
      };
      throw new UpdatePolicyError("UpdateBusy");
    }
    return handoff.status;
  }

  private clearRestartReservation(): void {
    if (this.reserved) this.terminal?.cancelUpdate(this.reserved.id);
    this.reserved = undefined;
    this.restartOperation = undefined;
    this.status = { ...this.status, attemptId: null };
  }

  markHandoffFailed(
    message = "The update could not be handed to the installer.",
    settlement?: ApplySettlement,
  ): void {
    if (settlement?.kind === "committed" || settlement?.kind === "unarmed-recovery") {
      if (settlement.kind === "unarmed-recovery") this.clearRestartReservation();
      this.candidate = undefined;
      this.status = {
        ...this.status,
        phase: "error",
        error: message,
        readyVersion: null,
        recoveryRequired: true,
        transaction: {
          status: "recovery-required",
          version: this.status.availableVersion,
          hash: this.status.availableHash,
          message,
        },
      };
      return;
    }
    this.clearRestartReservation();
    // Confirmed-unarmed failures keep authenticated bytes and their lease for Retry Update.
    this.status = { ...this.status, phase: "error", error: message };
  }

  async abandonPrepared(): Promise<void> {
    this.clearRestartReservation();
    await this.runtime?.abandonPrepared?.();
    this.candidate = undefined;
    if (this.status.recoveryRequired) return;
    this.status = {
      ...this.status,
      phase: "idle",
      availableVersion: null,
      availableHash: null,
      readyVersion: null,
      error: null,
      attemptId: null,
    };
  }

  private performCheck(): Promise<UpdateStatus> {
    if (!this.runtime) throw new UpdatePolicyError("UpdateUnsupported");
    const generation = this.generation;
    this.lastCheckAt = this.timers.now();
    this.status = { ...this.status, phase: "checking", error: null };
    return this.runtime
      .checkForUpdate()
      .then((result) => {
        if (generation !== this.generation || this.stopped) return this.statusValue();
        const eligible =
          result.available &&
          result.version !== null &&
          isHigherStableVersion(result.currentVersion, result.version);
        this.status = {
          ...this.status,
          installedVersion: result.currentVersion,
          availableVersion: eligible ? result.version : null,
          availableHash: eligible ? result.hash : null,
          phase: eligible ? "available" : result.available ? "error" : "idle",
          checkedAt: new Date(this.timers.now()).toISOString(),
          error:
            result.available && !eligible ? "The offered update version is not eligible." : null,
        };
        if (eligible && this.status.automaticUpdates) {
          void this.startDownloadOperation().catch(() => undefined);
        }
        return this.statusValue();
      })
      .catch((error) => {
        if (generation !== this.generation || this.stopped) return this.statusValue();
        this.status = {
          ...this.status,
          phase: "error",
          error: sanitizedUpdateError(error),
        };
        return this.statusValue();
      });
  }

  private performDownload(): Promise<UpdateStatus> {
    if (!this.runtime) throw new UpdatePolicyError("UpdateUnsupported");
    const generation = this.generation;
    const version = this.status.availableVersion;
    const hash = this.status.availableHash;
    this.status = { ...this.status, phase: "downloading", error: null };
    return this.runtime
      .prepareUpdateAttempt()
      .then(async (attempt) => {
        if (generation !== this.generation || this.stopped) return this.statusValue();
        if (attempt.candidate.version !== version || attempt.candidate.hash !== hash) {
          this.candidate = undefined;
          this.status = {
            ...this.status,
            availableVersion: null,
            availableHash: null,
            readyVersion: null,
          };
          try {
            await this.runtime?.abandonPrepared?.();
          } catch {
            this.status = {
              ...this.status,
              phase: "error",
              recoveryRequired: true,
              error:
                "The refused update could not be retired safely. Quit and inspect recovery state.",
            };
            return this.statusValue();
          }
          this.status = {
            ...this.status,
            phase: "error",
            error: "The prepared update did not match the selected release.",
          };
          return this.statusValue();
        }
        this.candidate = attempt.candidate;
        this.status = {
          ...this.status,
          availableVersion: attempt.candidate.version,
          availableHash: attempt.candidate.hash,
          readyVersion: attempt.candidate.version,
          recoveryPath: attempt.recovery.retained_bundle_path,
          phase: "ready",
          error: null,
        };
        return this.statusValue();
      })
      .catch((error) => {
        if (generation !== this.generation || this.stopped) return this.statusValue();
        this.status = {
          ...this.status,
          phase: "error",
          error: sanitizedUpdateError(error),
        };
        return this.statusValue();
      });
  }

  private scheduleChecks(): void {
    if (!this.initialized || !this.status.automaticUpdates || this.stopped) return;
    this.clearTimers();
    this.startupTimer = this.timers.setTimeout(() => {
      this.startupTimer = undefined;
      this.scheduledCheck();
    }, this.startupDelayMs);
    this.intervalTimer = this.timers.setInterval(() => {
      if (this.timers.now() - this.lastCheckAt >= this.checkIntervalMs) this.scheduledCheck();
    }, this.pollIntervalMs);
  }

  private scheduledCheck(): void {
    if (
      !this.initialized ||
      this.stopped ||
      !this.status.automaticUpdates ||
      this.checkOperation ||
      this.prepareOperation ||
      this.status.phase === "ready"
    )
      return;
    void this.check().catch(() => undefined);
  }

  private clearTimers(): void {
    if (this.startupTimer) this.timers.clearTimeout(this.startupTimer);
    if (this.intervalTimer) this.timers.clearInterval(this.intervalTimer);
    this.startupTimer = undefined;
    this.intervalTimer = undefined;
  }
}

function sanitizedUpdateError(error: unknown): string {
  if (error instanceof UpdateBoundaryError) {
    switch (error.code) {
      case "workerTimeout":
        return "Update preparation timed out.";
      case "cancelled":
        return "Update preparation was cancelled.";
      case "version":
        return "The offered update version is not eligible.";
      case "selection":
        return "The prepared update did not match the selected release.";
      case "archive":
        return "The downloaded update archive was rejected.";
      case "signature":
        return "The downloaded application signature was rejected.";
      case "recovery":
        return "The previous application could not be retained. The update was not installed.";
      case "feed":
        return "The update feed is not the approved source.";
      case "unavailable":
        return "Update preparation is unavailable in this build.";
      case "worker":
        return "Update preparation did not complete.";
      case "prepared":
        return "No complete prepared update is available.";
      case "state":
        return "The local update state is unavailable.";
      case "identity":
        return "The installed application identity is not eligible for updates.";
    }
  }
  if (error instanceof UpdatePolicyError) return error.message;
  return "The update operation failed.";
}
