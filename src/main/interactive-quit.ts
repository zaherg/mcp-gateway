import type { QuitCoordinator } from "./lifecycle";
import { asOrdinaryQuit, currentQuitInvocation } from "./updater/invocation";

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
      asOrdinaryQuit(() => this.lifecycle.handle(veto));
      return;
    }
    if (currentQuitInvocation() || this.lifecycle.status().phase !== "idle") {
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
          asOrdinaryQuit(() => {
            this.lifecycle.armQuit();
            this.quit();
          });
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
