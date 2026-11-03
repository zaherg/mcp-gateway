import { lstatSync, readdirSync } from "node:fs";
import type { FrozenCandidate } from "./candidate";
import {
  UPDATER_ARCH,
  UPDATER_CHANNEL,
  UPDATER_HASH_PATTERN,
  UPDATER_IDENTIFIER,
  UPDATER_PLATFORM,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";
import { currentQuitInvocation } from "./invocation";
import { readNativeJsonSync } from "./storage";
import {
  type ExpectedNativePlan,
  type JournalIdentity,
  type NativeBinding,
  nativeHelperPath,
  nativePlanPath,
  nativeResultPath,
  type TransactionLease,
  type UnarmedEvidence,
  type UnarmedReason,
  type UpdateAttempt,
} from "./transaction";

const NATIVE_ID_PATTERN = /^[a-f0-9]{32}$/;
const NATIVE_FILE_PATTERN = /^\.electrobun-update-([a-f0-9]{32})(?:\.result)?\.json$/;
const MAX_NATIVE_SCAN = 512;
const PLAN_FIELDS = [
  "app_bundle_path",
  "arch",
  "channel",
  "channel_root",
  "hash",
  "identifier",
  "parent_pid",
  "platform",
  "result_path",
  "retained_tar_path",
  "schema_version",
  "transaction_id",
  "version",
];

export type ApplySettlement =
  | Readonly<{
      kind: "unarmed" | "unarmed-recovery";
      reason: UnarmedReason;
    }>
  | Readonly<{
      kind: "committed";
      binding: NativeBinding | null;
      certainty: "bound" | "uncertain";
      parentMayExit: true;
    }>;

export interface HandoffAuthority {
  isCurrentUpdate(attemptId: number): boolean;
  isCleanupComplete(attemptId: number): boolean;
  attemptSignal(attemptId: number): AbortSignal | undefined;
}

export interface HandoffSession {
  readonly attemptId: number;
  readonly callId: string;
  readonly candidate: Readonly<FrozenCandidate>;
  readonly expected: ExpectedNativePlan;
  offerApprovalSync(): boolean;
  observeSdkStatusSync(entry: Readonly<{ status: string }>): void;
  settleReturnedCall(error?: unknown): ApplySettlement;
  settleWithoutCall(reason: UnarmedReason): ApplySettlement;
  retireUnarmed(): Promise<void>;
  retainUnarmed(): Promise<void>;
  releaseGuard(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === PLAN_FIELDS.length && PLAN_FIELDS.every((key, i) => keys[i] === key);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid native plan");
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error("invalid native plan");
  return value as number;
}

/** Read the exact SDK plan once; a missing/partial plan is uncertainty. */
function readObservedPlan(
  path: string,
  transactionId: string,
  expected: ExpectedNativePlan,
  candidate: Readonly<FrozenCandidate>,
): NativeBinding {
  const document = readNativeJsonSync(path);
  if (!isRecord(document) || !exactKeys(document) || document.schema_version !== 1)
    throw new Error("invalid native plan");
  const plan: ExpectedNativePlan = {
    identifier: requiredString(document, "identifier"),
    channel: UPDATER_CHANNEL,
    platform: UPDATER_PLATFORM,
    arch: UPDATER_ARCH,
    version: requiredString(document, "version"),
    hash: requiredString(document, "hash"),
    channelRoot: requiredString(document, "channel_root"),
    appBundlePath: requiredString(document, "app_bundle_path"),
    retainedTarPath: requiredString(document, "retained_tar_path"),
    parentPid: positiveInteger(document.parent_pid),
    physicalTemporaryDirectory: expected.physicalTemporaryDirectory,
  };
  if (
    requiredString(document, "transaction_id") !== transactionId ||
    requiredString(document, "result_path") !==
      nativeResultPath(expected.channelRoot, transactionId) ||
    requiredString(document, "channel") !== UPDATER_CHANNEL ||
    requiredString(document, "platform") !== UPDATER_PLATFORM ||
    requiredString(document, "arch") !== UPDATER_ARCH ||
    plan.identifier !== UPDATER_IDENTIFIER ||
    !UPDATER_STABLE_VERSION_PATTERN.test(plan.version) ||
    !UPDATER_HASH_PATTERN.test(plan.hash) ||
    plan.version !== candidate.version ||
    plan.hash !== candidate.hash ||
    plan.channelRoot !== expected.channelRoot ||
    plan.appBundlePath !== expected.appBundlePath ||
    plan.retainedTarPath !== expected.retainedTarPath ||
    plan.parentPid !== expected.parentPid
  )
    throw new Error("native plan mismatch");
  return {
    evidence: "observed-plan",
    transactionId,
    planPath: path,
    resultPath: nativeResultPath(expected.channelRoot, transactionId),
    helperPath: nativeHelperPath(expected.physicalTemporaryDirectory, transactionId),
    plan,
  };
}

export class HandoffSessionImplementation implements HandoffSession {
  readonly attemptId: number;
  readonly candidate: Readonly<FrozenCandidate>;
  private approved = false;
  private applying = false;
  private vetoed = false;
  private bindingError = false;
  private binding: NativeBinding | undefined;
  private evidence: UnarmedEvidence | undefined;
  private settlement: ApplySettlement | undefined;
  private requestingApproval = false;
  private armingFailed = false;
  private errorObserved = false;

  constructor(
    private readonly lease: TransactionLease,
    attempt: UpdateAttempt,
    readonly expected: ExpectedNativePlan,
    readonly callId: string,
    private readonly authority: HandoffAuthority,
  ) {
    this.attemptId = attempt.id;
    this.candidate = attempt.candidate;
    const identity = this.identity();
    if (
      this.lease.snapshot().attempt_id !== attempt.id ||
      this.lease.snapshot().lease_id !== identity.nonce
    )
      throw new Error("handoff session does not own the prepared attempt");
  }

  private identity(): JournalIdentity {
    return { nonce: this.lease.snapshot().lease_id, attemptId: this.attemptId };
  }

  offerApprovalSync(): boolean {
    const invocation = currentQuitInvocation();
    if (
      this.requestingApproval ||
      invocation?.kind !== "sdk-apply" ||
      invocation.attemptId !== this.attemptId ||
      invocation.callId !== this.callId
    )
      return false;
    if (this.approved) return false;
    this.requestingApproval = true;
    try {
      const signal = this.authority.attemptSignal(this.attemptId);
      if (
        !this.authority.isCurrentUpdate(this.attemptId) ||
        !this.authority.isCleanupComplete(this.attemptId) ||
        !signal ||
        signal.aborted
      )
        return false;
      this.lease.armHandoffSync(this.identity());
      this.approved = true;
      return true;
    } catch {
      this.armingFailed = true;
      return false;
    } finally {
      this.requestingApproval = false;
    }
  }

  observeSdkStatusSync(entry: Readonly<{ status: string }>): void {
    const invocation = currentQuitInvocation();
    if (
      invocation?.kind !== "sdk-apply" ||
      invocation.attemptId !== this.attemptId ||
      invocation.callId !== this.callId
    )
      return;
    try {
      switch (entry.status) {
        case "applying":
          this.applying = true;
          return;
        case "launching-new-version":
          this.observeBindingSync();
          return;
        case "idle":
          if (!this.applying && !this.binding) this.vetoed = true;
          return;
        case "error":
          this.errorObserved = true;
          return;
        default:
          return;
      }
    } catch {
      this.bindingError = true;
    }
  }

  private observeBindingSync(): void {
    if (this.binding) return;
    const snapshot = this.lease.snapshot();
    const existing = new Set(snapshot.existing_native_ids);
    const discovered = new Map<string, { plan: boolean; result: boolean }>();
    let seen = 0;
    for (const name of readdirSync(this.expected.channelRoot)) {
      seen++;
      if (seen > MAX_NATIVE_SCAN) {
        this.bindingError = true;
        return;
      }
      const match = NATIVE_FILE_PATTERN.exec(name);
      if (!match?.[1] || existing.has(match[1])) continue;
      const state = discovered.get(match[1]) ?? { plan: false, result: false };
      if (name.endsWith(".result.json")) state.result = true;
      else state.plan = true;
      discovered.set(match[1], state);
    }
    if (discovered.size !== 1) {
      this.bindingError = true;
      return;
    }
    const [transactionId, available] = [...discovered.entries()][0] ?? [];
    if (!transactionId || !available || !NATIVE_ID_PATTERN.test(transactionId)) {
      this.bindingError = true;
      return;
    }
    let binding: NativeBinding;
    if (available.plan) {
      const planPath = nativePlanPath(this.expected.channelRoot, transactionId);
      const stat = lstatSync(planPath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        this.bindingError = true;
        return;
      }
      binding = readObservedPlan(planPath, transactionId, this.expected, this.candidate);
    } else {
      const resultPath = nativeResultPath(this.expected.channelRoot, transactionId);
      const stat = lstatSync(resultPath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        this.bindingError = true;
        return;
      }
      binding = {
        evidence: "early-terminal-result",
        transactionId,
        resultPath,
        helperPath: nativeHelperPath(this.expected.physicalTemporaryDirectory, transactionId),
      };
    }
    try {
      this.lease.bindNativeSync(this.identity(), binding);
      this.binding = binding;
    } catch {
      this.bindingError = true;
    }
  }

  settleReturnedCall(error?: unknown): ApplySettlement {
    if (this.settlement) return this.settlement;
    if (this.binding) {
      this.settlement = Object.freeze({
        kind: "committed" as const,
        binding: this.binding,
        certainty: "bound" as const,
        parentMayExit: true as const,
      });
      return this.settlement;
    }
    if (this.vetoed && !this.applying && !this.bindingError) {
      this.settlement = this.settleWithoutCall("vetoed");
      return this.settlement;
    }
    if (
      this.approved ||
      this.applying ||
      this.bindingError ||
      this.lease.snapshot().phase === "arming" ||
      this.lease.snapshot().phase === "handed-off"
    ) {
      this.settlement = Object.freeze({
        kind: "committed" as const,
        binding: null,
        certainty: "uncertain" as const,
        parentMayExit: true as const,
      });
      return this.settlement;
    }
    const signal = this.authority.attemptSignal(this.attemptId);
    const reason: UnarmedReason = signal?.aborted
      ? "cancelled"
      : this.errorObserved || error !== undefined
        ? "preapproval-error"
        : "validation-refused";
    this.settlement = this.settleWithoutCall(reason);
    return this.settlement;
  }

  settleWithoutCall(reason: UnarmedReason): ApplySettlement {
    if (this.settlement) return this.settlement;
    if (this.armingFailed || this.lease.snapshot().phase === "arming") {
      try {
        this.evidence = this.lease.proveUnarmed(this.identity(), {
          reason,
          approvalOffered: this.approved,
          applyingObserved: false,
          bindingObserved: false,
        });
      } catch {
        this.bindingError = true;
      }
    }
    this.settlement = Object.freeze({ kind: "unarmed" as const, reason });
    return this.settlement;
  }

  async retainUnarmed(): Promise<void> {
    if (this.settlement?.kind !== "unarmed")
      throw new Error("Only confirmed unarmed preparation can be retained");
    await this.lease.restorePrepared(this.identity(), this.evidence);
  }

  async retireUnarmed(): Promise<void> {
    const settlement = this.settlement;
    if (settlement?.kind !== "unarmed")
      throw new Error("unarmed retirement requires a settled unarmed invocation");
    if (this.evidence) await this.lease.retireUnarmed(this.identity(), this.evidence);
    else await this.lease.releaseUncommitted();
  }

  releaseGuard(): void {
    this.lease.releaseGuard();
  }
}
