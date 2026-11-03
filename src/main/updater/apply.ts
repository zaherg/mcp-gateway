import type { VerifiedCandidate } from "./boundary";
import { isHigherStableVersion } from "./candidate";
import type { ApplySettlement, HandoffSession } from "./handoff";
import { withQuitInvocation } from "./invocation";
import { admitSdkRoot } from "./support";
import type { UpdateAttempt } from "./transaction";

export interface LocalUpdateInfo {
  version: string;
  hash: string;
  baseUrl: string;
  channel: string;
  name: string;
  displayName?: string;
  identifier: string;
}

export interface ApplySdk {
  applyUpdate(): Promise<void>;
  onStatusChange(callback: ((entry: Readonly<{ status: string }>) => void) | null): void;
  getLocalInfo(verified: VerifiedCandidate, channelRoot: string): Promise<LocalUpdateInfo>;
  appDataFolder(): Promise<string>;
}

export interface ApplyOutcome {
  settlement: ApplySettlement;
}

export class UpdateHandoffUnavailableError extends Error {
  readonly code = "UpdateHandoffUnavailable";

  constructor() {
    super("The update handoff is unavailable until its required safety checks pass.");
    this.name = "UpdateHandoffUnavailableError";
  }
}

/**
 * Adapt only the pinned SDK surface used by the handoff. Each member is invoked
 * explicitly so a missing capability fails before any native transaction exists.
 */
export async function loadApplySdk(): Promise<ApplySdk> {
  const { Updater, Utils } = await import("electrobun/main");
  if (
    typeof Updater.applyUpdate !== "function" ||
    typeof Updater.onStatusChange !== "function" ||
    typeof Updater.getLocalInfo !== "function" ||
    typeof Updater.appDataFolder !== "function"
  )
    throw new UpdateHandoffUnavailableError();
  let admittedRoot: string | undefined;
  const admit = (root: string) =>
    admitSdkRoot(root, Utils.paths.appData, Utils.resolveInstalledRootNameForPaths);
  return {
    applyUpdate: () => {
      if (!admittedRoot) throw new Error("SDK handoff has not been admitted");
      return Updater.applyUpdate();
    },
    onStatusChange: (callback) => {
      if (callback && !admittedRoot) throw new Error("SDK handoff has not been admitted");
      Updater.onStatusChange(callback ? (entry) => callback({ status: entry.status }) : null);
    },
    getLocalInfo: async (verified, channelRoot) => {
      const before = await admit(channelRoot);
      if (
        before.version !== verified.metadata.version ||
        before.hash !== verified.metadata.hash ||
        !isHigherStableVersion(before.version, verified.candidate.version)
      )
        throw new Error("SDK metadata does not match the verified update attempt");
      let info: LocalUpdateInfo;
      try {
        info = await Updater.getLocalInfo();
      } finally {
        // Pinned 2.0.5 only polls when prepared equals running. The guarded,
        // verified higher candidate excludes that branch; drain its first timer
        // and cached-info microtasks before ownership or status observers change.
        await new Promise<void>((done) => setTimeout(done, 0));
        await Promise.resolve();
      }
      for (const key of [
        "identifier",
        "channel",
        "version",
        "hash",
        "baseUrl",
        "name",
        "displayName",
      ] as const)
        if (info[key] !== before[key]) throw new Error("SDK metadata changed during admission");
      admittedRoot = channelRoot;
      return info;
    },
    appDataFolder: async () => {
      if (!admittedRoot) throw new Error("SDK handoff has not been admitted");
      await admit(admittedRoot);
      const actual = await Updater.appDataFolder();
      if (actual !== admittedRoot) throw new Error("SDK root changed after admission");
      return actual;
    },
  };
}

async function retainReturnedPreparation(
  session: HandoffSession,
  settlement: ApplySettlement,
): Promise<ApplySettlement> {
  if (settlement.kind !== "unarmed") return settlement;
  try {
    await session.retainUnarmed();
    return settlement;
  } catch {
    return { kind: "unarmed-recovery", reason: settlement.reason };
  }
}

export async function applyVerifiedUpdate(
  attempt: UpdateAttempt,
  session: HandoffSession,
  sdk: ApplySdk,
): Promise<ApplyOutcome> {
  if (session.attemptId !== attempt.id) throw new Error("update attempt/session mismatch");
  if (attempt.signal.aborted) {
    return {
      settlement: await retainReturnedPreparation(session, session.settleWithoutCall("cancelled")),
    };
  }
  let error: unknown;
  try {
    sdk.onStatusChange((entry) => session.observeSdkStatusSync(entry));
    await withQuitInvocation(
      { kind: "sdk-apply", attemptId: session.attemptId, callId: session.callId },
      () => sdk.applyUpdate(),
    );
  } catch (caught) {
    error = caught;
  } finally {
    try {
      sdk.onStatusChange(null);
    } catch {}
  }
  return {
    settlement: await retainReturnedPreparation(session, session.settleReturnedCall(error)),
  };
}
