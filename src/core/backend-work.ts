// A shared budget for client requests whose backend work has not ended.
//
// Separate from HTTP request admission and from backend resource ownership: an
// established session's call continues after its response stream closes, so
// its slot stays charged until the backend replies, the client sends the
// protocol cancellation, or the owned session/request cleanup completes.
// Neither a disconnect nor a cleanup deadline proves that work has ended.
export const MAX_BACKEND_CALLS = 16;

/** Opaque identity for one session, child or outer modern request. */
export type WorkOwner = object;

// Application error codes start at 1001, outside JSON-RPC's and the base spec's
// reserved legacy server-error range (-32000..-32019).
/** Fixed sanitized refusal for a validated transport that already owns the response. */
export const BACKEND_CAPACITY_ERROR = {
  code: 1001,
  message: "Backend work capacity is exhausted. Retry when outstanding calls finish.",
} as const;

/** A second in-flight request with an id this session already owns. */
export const DUPLICATE_REQUEST_ERROR = {
  code: -32600,
  message: "Duplicate in-flight request id.",
} as const;

/** The per-session backend-facing id space is exhausted; ids are never reused. */
export const BACKEND_ID_EXHAUSTED_ERROR = {
  code: 1001,
  message: "Backend request id capacity is exhausted.",
} as const;

/**
 * Backend-facing request ids for one session's peer.
 *
 * Client ids are not forwarded: each admitted request gets the next wire id,
 * and only active mappings are retained, so a late reply for a cancelled or
 * reused client id cannot match newer work. Wire ids are never reused within a
 * peer's lifetime, and the counter refuses rather than wraps.
 */
export class BackendWireIds {
  private next = 1;
  private readonly wires = new Map<number, string | number>();
  private readonly originals = new Map<string | number, number>();

  constructor(private readonly limit = Number.MAX_SAFE_INTEGER) {}

  get size(): number {
    return this.wires.size;
  }

  holds(original: string | number): boolean {
    return this.originals.has(original);
  }

  /** Allocate the next wire id, or undefined when the id space is exhausted. */
  register(original: string | number): number | undefined {
    if (this.next > this.limit) return undefined;
    const wire = this.next++;
    this.originals.set(original, wire);
    this.wires.set(wire, original);
    return wire;
  }

  /** The active wire id for a client id, for a matching cancellation. */
  wireOf(original: string | number): number | undefined {
    return this.originals.get(original);
  }

  /** Take the client id a backend reply answers, removing that mapping. */
  take(wire: number): string | number | undefined {
    const original = this.wires.get(wire);
    if (original === undefined) return undefined;
    this.wires.delete(wire);
    if (this.originals.get(original) === wire) this.originals.delete(original);
    return original;
  }

  /** Remove a mapping without a backend reply (forwarded cancellation/refusal). */
  release(original: string | number): number | undefined {
    const wire = this.originals.get(original);
    if (wire === undefined) return undefined;
    this.originals.delete(original);
    if (this.wires.get(wire) === original) this.wires.delete(wire);
    return wire;
  }

  clear(): void {
    this.wires.clear();
    this.originals.clear();
  }
}

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
