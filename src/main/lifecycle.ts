import type { QuitStatus } from "../shared/rpc";
import type { FrozenCandidate } from "./updater/candidate";
import type { ApplySettlement, HandoffAuthority, HandoffSession } from "./updater/handoff";
import { asOrdinaryQuit, currentQuitInvocation } from "./updater/invocation";
import type { UpdateAttempt } from "./updater/transaction";

export type UpdateDispatch = (attempt: UpdateAttempt) => Promise<ApplySettlement>;
export type AbandonUpdate = (attemptId: number | undefined) => Promise<void>;

type UpdateIntent = { kind: "update"; attempt: UpdateAttempt };
type TerminalIntent = { kind: "quit" } | UpdateIntent;

export class QuitCoordinator {
  private state: QuitStatus = { attempt: 0, phase: "idle", error: null };
  private intent: TerminalIntent | undefined;
  private handoff: HandoffSession | undefined;
  private approved = false;
  private cleanupDone = false;
  private cleanupInFlight: Promise<void> | undefined;
  private dispatchInFlight: Promise<ApplySettlement> | undefined;
  private abandonmentInFlight: Promise<void> | undefined;
  private readonly controllers = new Map<number, AbortController>();
  private sequence = 0;

  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly quitAgain: () => void,
    private readonly onFailure: (
      error: unknown,
      kind: "quit" | "update",
      settlement?: ApplySettlement,
    ) => void,
    private readonly update: UpdateDispatch = async () => ({ kind: "unarmed", reason: "vetoed" }),
    private readonly abandon: AbandonUpdate = async () => undefined,
  ) {}

  status(): QuitStatus {
    return { ...this.state };
  }

  /** Reserve terminal identity before any queue or await. */
  reserveUpdate(candidate: FrozenCandidate): UpdateAttempt | undefined {
    if (this.approved) return undefined;
    if (this.state.phase === "pending" || this.state.phase === "ready") return undefined;
    const existing = this.intent;
    if (existing?.kind === "update") {
      if (
        existing.attempt.candidate.version === candidate.version &&
        existing.attempt.candidate.hash === candidate.hash
      )
        return existing.attempt;
      return undefined;
    }
    const id = ++this.sequence;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const attempt: UpdateAttempt = Object.freeze({
      id,
      candidate,
      signal: controller.signal,
    });
    this.intent = { kind: "update", attempt };
    this.state = { attempt: id, phase: "idle", error: null };
    return attempt;
  }

  /** A restart request keeps the reserved attempt and starts tagged cleanup. */
  acceptUpdateRestart(attempt: UpdateAttempt): boolean {
    const current = this.intent;
    if (
      current?.kind !== "update" ||
      current.attempt.id !== attempt.id ||
      current.attempt.candidate.version !== attempt.candidate.version ||
      current.attempt.candidate.hash !== attempt.candidate.hash ||
      attempt.signal.aborted ||
      this.state.phase === "ready"
    )
      return false;
    if (this.state.phase === "pending" || this.dispatchInFlight || this.cleanupInFlight)
      return true;
    this.state = { attempt: attempt.id, phase: "pending", error: null };
    this.cleanupDone = false;
    this.approved = false;
    return true;
  }

  cancelUpdate(attemptId: number): void {
    this.controllers.get(attemptId)?.abort();
    this.controllers.delete(attemptId);
    if (this.intent?.kind === "update" && this.intent.attempt.id === attemptId)
      this.intent = undefined;
    if (this.handoff?.attemptId === attemptId) this.handoff = undefined;
    this.approved = false;
    this.cleanupDone = false;
    if (!this.cleanupInFlight && !this.dispatchInFlight)
      this.state = {
        attempt: this.state.attempt,
        phase: "failed",
        error: "The update attempt was cancelled.",
      };
  }

  registerHandoff(session: HandoffSession): boolean {
    const intent = this.intent;
    if (
      intent?.kind !== "update" ||
      intent.attempt.id !== session.attemptId ||
      !this.cleanupDone ||
      this.approved
    )
      return false;
    this.handoff = session;
    return true;
  }

  unregisterHandoff(session: HandoffSession): void {
    if (this.handoff === session) this.handoff = undefined;
  }

  readonly handoffAuthority: HandoffAuthority = {
    isCurrentUpdate: (attemptId: number): boolean =>
      this.intent?.kind === "update" &&
      this.intent.attempt.id === attemptId &&
      this.state.attempt === attemptId &&
      !this.intent.attempt.signal.aborted,
    isCleanupComplete: (attemptId: number): boolean =>
      this.intent?.kind === "update" && this.intent.attempt.id === attemptId && this.cleanupDone,
    attemptSignal: (attemptId: number): AbortSignal | undefined =>
      this.intent?.kind === "update" && this.intent.attempt.id === attemptId
        ? this.intent.attempt.signal
        : undefined,
  };

  /** A normal user quit must never inherit a previously selected update. */
  armQuit(): boolean {
    if (this.approved || this.state.phase === "ready") return false;
    if (this.intent?.kind === "update") {
      this.abortAttempt(this.intent.attempt.id);
      this.intent = { kind: "quit" };
    } else {
      this.intent = { kind: "quit" };
    }
    return true;
  }

  /** Native events are synchronous: veto now and request quit again after cleanup. */
  handle(veto: () => void): void {
    if (this.approved) return;
    const invocation = currentQuitInvocation();
    if (invocation?.kind === "begin-update-shutdown") {
      veto();
      if (
        this.intent?.kind === "update" &&
        this.intent.attempt.id === invocation.attemptId &&
        !this.intent.attempt.signal.aborted
      )
        this.ensureCleanup(invocation.attemptId);
      return;
    }
    if (invocation?.kind === "sdk-apply") {
      const session = this.handoff;
      const matches =
        session !== undefined &&
        session.attemptId === invocation.attemptId &&
        session.callId === invocation.callId;
      if (matches && this.intent?.kind === "update" && this.cleanupDone) {
        if (session.offerApprovalSync()) {
          this.approved = true;
          return;
        }
      }
      veto();
      return;
    }
    if (this.state.phase === "ready") return;
    veto();
    this.ordinaryIntent();
  }

  private ordinaryIntent(): void {
    if (this.intent?.kind === "update") {
      this.abortAttempt(this.intent.attempt.id);
      this.intent = { kind: "quit" };
    } else {
      this.intent = { kind: "quit" };
    }
    if (this.cleanupDone) {
      if (!this.dispatchInFlight) void this.finishAfterAbandon();
      return;
    }
    if (this.cleanupInFlight) return;
    const attempt =
      this.state.phase === "idle"
        ? Math.max(this.state.attempt, this.sequence) + 1
        : this.state.attempt + 1;
    this.state = { attempt, phase: "pending", error: null };
    this.ensureCleanup(attempt);
  }

  private abortAttempt(attemptId: number): void {
    this.controllers.get(attemptId)?.abort();
  }

  private ensureCleanup(attemptId: number): void {
    if (this.cleanupInFlight || this.dispatchInFlight || this.cleanupDone) return;
    this.cleanupDone = false;
    this.cleanupInFlight = Promise.resolve()
      .then(this.cleanup)
      .then(() => {
        this.cleanupInFlight = undefined;
        this.cleanupDone = true;
        void this.afterCleanup(attemptId);
      })
      .catch((error) => {
        this.cleanupInFlight = undefined;
        const wasUpdate = this.intent?.kind === "update";
        this.intent = undefined;
        this.state = {
          attempt: this.state.attempt,
          phase: "failed",
          error: wasUpdate
            ? "Update cleanup failed. The app has not exited. Retry Update or Quit."
            : "Quit cleanup failed. The app has not exited. Retry Quit.",
        };
        this.onFailure(error, wasUpdate ? "update" : "quit");
      });
  }

  private async afterCleanup(attemptId: number): Promise<void> {
    const intent = this.intent;
    if (!intent || intent.kind === "quit") {
      await this.finishAfterAbandon();
      return;
    }
    if (intent.attempt.id !== attemptId || intent.attempt.signal.aborted) {
      await this.finishAfterAbandon();
      return;
    }
    this.state = { attempt: intent.attempt.id, phase: "pending", error: null };
    const operation = Promise.resolve().then(() => this.update(intent.attempt));
    this.dispatchInFlight = operation;
    let settlement: ApplySettlement;
    try {
      settlement = await operation;
    } catch (error) {
      this.dispatchInFlight = undefined;
      if (this.intent?.kind === "quit") {
        await this.finishAfterAbandon();
        return;
      }
      this.intent = undefined;
      this.state = {
        attempt: intent.attempt.id,
        phase: "failed",
        error: "Update handoff failed. The gateway is stopped. Retry Update or Quit.",
      };
      this.onFailure(error, "update");
      return;
    }
    this.dispatchInFlight = undefined;
    if (this.intent?.kind === "quit") {
      await this.finishAfterAbandon();
      return;
    }
    if (settlement.kind === "committed") {
      // A returned SDK call is not evidence that native exit occurred. Keep the
      // durable embargo, but let an ordinary Quit exit the already-cleaned parent.
      this.approved = false;
      this.intent = undefined;
      this.state = {
        attempt: intent.attempt.id,
        phase: "failed",
        error:
          "Update handoff returned without confirmed exit. Installation may be committed. Quit and use the retained recovery copy if needed; do not retry installation.",
      };
      this.onFailure(new Error("Committed update handoff returned"), "update", settlement);
      return;
    }
    if (this.intent?.kind === "update") this.intent = undefined;
    this.state = {
      attempt: intent.attempt.id,
      phase: "failed",
      error:
        settlement.kind === "unarmed-recovery"
          ? "Update handoff was unarmed, but preparation could not be restored safely. Quit and inspect retained recovery state; Retry Update is unavailable."
          : "Update handoff was refused. Retry Update or Quit.",
    };
    this.onFailure(new Error("Update handoff refused"), "update", settlement);
  }

  private finishAfterAbandon(): Promise<void> {
    if (this.abandonmentInFlight) return this.abandonmentInFlight;
    const operation = this.completeOrdinaryQuit().finally(() => {
      if (this.abandonmentInFlight === operation) this.abandonmentInFlight = undefined;
    });
    this.abandonmentInFlight = operation;
    return operation;
  }

  private async completeOrdinaryQuit(): Promise<void> {
    const attemptId = this.intent?.kind === "update" ? this.intent.attempt.id : undefined;
    try {
      await this.abandon(attemptId);
      this.intent = undefined;
      this.state = { attempt: this.state.attempt, phase: "ready", error: null };
      await asOrdinaryQuit(() => this.quitAgain());
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
