import { AsyncLocalStorage } from "node:async_hooks";

export type QuitInvocation =
  | Readonly<{ kind: "begin-update-shutdown"; attemptId: number }>
  | Readonly<{ kind: "sdk-apply"; attemptId: number; callId: string }>;

const ordinary = Object.freeze({ kind: "ordinary" as const });
type Ordinary = typeof ordinary;
const invocation = new AsyncLocalStorage<QuitInvocation | Ordinary>();

/** The invocation is private to this process; it is never exposed through RPC. */
export function currentQuitInvocation(): QuitInvocation | Ordinary | undefined {
  return invocation.getStore();
}

export function withQuitInvocation<T>(origin: QuitInvocation, work: () => T): T {
  return invocation.run(Object.freeze({ ...origin }), work);
}

export function asOrdinaryQuit<T>(work: () => T): T {
  return invocation.run(ordinary, work);
}
