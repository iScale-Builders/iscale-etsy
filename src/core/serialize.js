// Serialize async tasks by key so two operations on the SAME key never overlap.
// saveListing does read-modify-write across two IndexedDB transactions (getRecord
// -> recordScrape -> putRecord) with an await between them; two concurrent saves
// for the same listing (e.g. the passive auto-save timer racing a batch visit of
// the same URL) would both read the same record, each append their own
// demand_history entry, and the second put would clobber the first — dropping a
// scrape observation. Chaining same-key tasks makes each see the prior's result.
// Tasks for DIFFERENT keys still run concurrently.
export function createKeyedQueue() {
  const tails = new Map();
  return function run(key, task) {
    const prev = tails.get(key) || Promise.resolve();
    // `prev` (the chaining tail) is always a resolved promise, so task runs after
    // the previous same-key task settles whether it resolved or threw — one
    // failed save can't wedge the key.
    const next = prev.then(task);
    // The internal tail must never be a rejected promise: that would surface as
    // an unhandled rejection AND reject the next same-key task's `prev`. Swallow
    // its settlement; the caller still gets the real `next` to handle.
    const tail = next.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    // Drop the map entry once this key drains, so it can't grow unbounded.
    tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}
