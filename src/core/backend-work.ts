// A shared budget for client requests whose backend work has not ended.
//
// Separate from HTTP request admission and from backend resource ownership: a
// stateless request's call continues after its response stream closes, so its
// slot stays charged until the backend replies, the client sends the protocol
// cancellation, or the owned request cleanup completes. Neither a disconnect
// nor a cleanup deadline proves that work has ended.
export const MAX_BACKEND_CALLS = 16;

/** Opaque identity for one request's backend work. */
export type WorkOwner = object;

// Application error codes start at 1001, outside JSON-RPC's and the base spec's
// reserved server-error range (-32000..-32019).
/** Fixed sanitized refusal for a validated transport that already owns the response. */
export const BACKEND_CAPACITY_ERROR = {
  code: 1001,
  message: "Backend work capacity is exhausted. Retry when outstanding calls finish.",
} as const;

export class BackendCalls {
  private used = 0;
  private readonly owned = new Map<WorkOwner, Map<string | number, true>>();

  constructor(private readonly limit = MAX_BACKEND_CALLS) {}

  get outstanding(): number {
    return this.used;
  }

  /** A fresh ownership identity; never reused after its cleanup. */
  owner(): WorkOwner {
    return Object.freeze({});
  }

  /** Whether this owner already holds a reservation for the exact id. */
  holds(owner: WorkOwner, id: string | number): boolean {
    return this.owned.get(owner)?.has(id) === true;
  }

  /**
   * Charge one in-flight request. A duplicate id is refused rather than
   * charged twice; callers must not dispatch it a second time.
   */
  admit(owner: WorkOwner, id: string | number): boolean {
    let calls = this.owned.get(owner);
    if (calls?.has(id)) return false;
    if (this.used >= this.limit) return false;
    if (!calls) {
      calls = new Map();
      this.owned.set(owner, calls);
    }
    calls.set(id, true);
    this.used++;
    return true;
  }

  /** Release a call this owner was charged for; unknown ids release nothing. */
  settle(owner: WorkOwner, id: string | number): boolean {
    const calls = this.owned.get(owner);
    if (!calls?.delete(id)) return false;
    this.used--;
    if (calls.size === 0) this.owned.delete(owner);
    return true;
  }

  /** Release everything an owner still holds, only after confirmed cleanup. */
  settleOwner(owner: WorkOwner): number {
    const calls = this.owned.get(owner);
    if (!calls) return 0;
    this.owned.delete(owner);
    this.used -= calls.size;
    return calls.size;
  }
}

/**
 * Run `release` only when the owned cleanup fulfilled. A rejected cleanup is
 * unconfirmed and keeps its work charged for a retry.
 */
export async function releaseAfterCleanup<T>(cleanup: Promise<T>, release: () => void): Promise<T> {
  const value = await cleanup;
  release();
  return value;
}
