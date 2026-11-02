import type { QuitStatus } from "../shared/rpc";

export class QuitCoordinator {
  private state: QuitStatus = { attempt: 0, phase: "idle", error: null };
  private pending: Promise<void> | undefined;
  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly quitAgain: () => void,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  status(): QuitStatus {
    return { ...this.state };
  }

  /** Native events are synchronous: veto now and request quit again after cleanup. */
  handle(veto: () => void): void {
    if (this.state.phase === "ready") return;
    veto();
    if (this.pending) return;
    const attempt = this.state.attempt + 1;
    this.state = { attempt, phase: "pending", error: null };
    this.pending = Promise.resolve()
      .then(this.cleanup)
      .then(() => {
        this.state = { attempt, phase: "ready", error: null };
        this.quitAgain();
      })
      .catch((error) => {
        this.pending = undefined;
        this.state = {
          attempt,
          phase: "failed",
          error: "Quit cleanup failed. The app has not exited. Retry Quit.",
        };
        this.onFailure(error);
      });
  }
}
