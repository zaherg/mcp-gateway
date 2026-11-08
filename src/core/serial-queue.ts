/** Runs tasks one at a time in call order; a failed task does not block later ones. */
export const createSerialQueue = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <A>(work: () => Promise<A> | A): Promise<A> => {
    const run = tail.then(() => work());
    // Keep the chain alive after a failure; the caller still receives the rejection.
    tail = run.catch(() => undefined);
    return run;
  };
};
