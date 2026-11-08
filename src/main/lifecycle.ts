import type { QuitStatus } from "../shared/rpc";

type Intent = "quit" | "update" | undefined;

/** Serializes terminal cleanup and keeps an update restart distinct from an ordinary quit. */
export class QuitCoordinator {
  private state: QuitStatus = { attempt: 0, phase: "idle", error: null };
  private intent: Intent;
  private approved = false;
  private cleanupDone = false;
  private cleanupInFlight: Promise<void> | undefined;
  private sequence = 0;

  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly quitAgain: () => void,
    private readonly onFailure: (error: unknown, kind: "quit" | "update") => void,
  ) {}

  status(): QuitStatus {
    return { ...this.state };
  }

  updateRestartActive(): boolean {
    return this.intent === "update";
  }

  /** Runs cleanup for an update restart; false means an ordinary quit won. */
  async beginUpdateRestart(): Promise<boolean> {
    if (this.approved || this.state.phase === "ready") return false;
    if (this.intent === "quit") return false;
    if (this.cleanupDone) {
      if (this.intent !== "update") {
        this.intent = "update";
        this.state = { attempt: ++this.sequence, phase: "pending", error: null };
      }
      return true;
    }
    if (this.intent !== "update") {
      this.intent = "update";
      this.state = { attempt: ++this.sequence, phase: "pending", error: null };
      this.cleanupDone = false;
    }
    await this.ensureCleanup();
    return this.intent === "update" && this.cleanupDone;
  }

  approveUpdateRestart(): void {
    if (this.intent === "update" && this.cleanupDone) this.approved = true;
  }

  clearUpdateRestart(): void {
    this.approved = false;
    if (this.intent === "update") this.intent = undefined;
  }

  updateRestartFailed(message: string): void {
    this.approved = false;
    this.intent = undefined;
    this.state = { attempt: this.state.attempt, phase: "failed", error: message };
    this.onFailure(new Error(message), "update");
  }

  /** A normal user quit must never inherit a previously selected update. */
  armQuit(): boolean {
    if (this.approved || this.state.phase === "ready") return false;
    if (this.intent === "quit" && this.state.phase === "pending") return true;
    this.intent = "quit";
    this.state = { attempt: ++this.sequence, phase: "pending", error: null };
    return true;
  }

  /** Native events are synchronous: veto now and request quit again after cleanup. */
  handle(veto: () => void, signal = false): void {
    if (this.approved && !signal) return;
    if (signal) {
      this.approved = false;
      if (this.intent === "update") this.intent = undefined;
    }
    if (this.state.phase === "ready") return;
    veto();
    this.ordinaryIntent();
  }

  private ordinaryIntent(): void {
    if (!this.armQuit()) return;
    if (this.cleanupDone) {
      void this.finishAfterCleanup();
      return;
    }
    void this.ensureCleanup().catch(() => undefined);
  }

  private ensureCleanup(): Promise<void> {
    if (this.cleanupDone) return Promise.resolve();
    if (this.cleanupInFlight) return this.cleanupInFlight;
    this.cleanupDone = false;
    const operation = Promise.resolve()
      .then(this.cleanup)
      .then(() => {
        this.cleanupDone = true;
        if (this.intent === "quit") void this.finishAfterCleanup();
      })
      .catch((error) => {
        const wasUpdate = this.intent === "update";
        this.intent = undefined;
        this.state = {
          attempt: this.state.attempt,
          phase: "failed",
          error: wasUpdate
            ? "Update cleanup failed. The app has not exited. Use Quit, then reopen the app to retry the update."
            : "Quit cleanup failed. The app has not exited. Retry Quit.",
        };
        this.onFailure(error, wasUpdate ? "update" : "quit");
        throw error;
      })
      .finally(() => {
        if (this.cleanupInFlight === operation) this.cleanupInFlight = undefined;
      });
    this.cleanupInFlight = operation;
    return operation;
  }

  private async finishAfterCleanup(): Promise<void> {
    if (this.intent !== "quit") return;
    this.state = { attempt: this.state.attempt, phase: "ready", error: null };
    try {
      this.quitAgain();
    } catch (error) {
      this.cleanupDone = false;
      this.state = {
        attempt: this.state.attempt,
        phase: "failed",
        error: "Quit cleanup failed. The app has not exited. Retry Quit.",
      };
      this.onFailure(error, "quit");
    }
  }
}

/** A renderer acknowledgement only confirms delivery, never consent to discard a draft. */
export class InteractiveQuitGate {
  private pending: Promise<void> | undefined;

  constructor(
    private readonly lifecycle: QuitCoordinator,
    private readonly requestRenderer: () => Promise<boolean> | undefined,
    private readonly quit: () => void,
    private readonly onUnavailable: (error: unknown) => void,
    private readonly signalRequested: () => boolean = () => false,
  ) {}

  handle(veto: () => void): void {
    if (this.signalRequested()) {
      // A native signal is terminal intent, including during update preflight or
      // an unanswered draft prompt. It must never inherit install-on-quit.
      this.lifecycle.handle(veto, true);
      return;
    }
    if (this.lifecycle.status().phase !== "idle" || this.lifecycle.updateRestartActive()) {
      this.lifecycle.handle(veto);
      return;
    }
    veto();
    if (this.pending) return;
    this.pending = Promise.resolve()
      .then(async () => {
        const acknowledgement = this.requestRenderer();
        if (acknowledgement === undefined) {
          // No window means no retained renderer draft. Cmd+W persistence is unchanged.
          this.lifecycle.armQuit();
          this.quit();
        } else if ((await acknowledgement) !== true) {
          throw new Error("The window did not acknowledge the interactive Quit request.");
        }
      })
      .catch((error) => {
        // A lost acknowledgement after an approved request must not interrupt cleanup.
        if (this.lifecycle.status().phase === "idle") this.onUnavailable(error);
      })
      .finally(() => {
        this.pending = undefined;
      });
  }
}
