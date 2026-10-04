// Where the service keeps its state, behind four async calls (get, put, delete, list by prefix), so the same service
// runs on a JSON file in Node and on a Durable Object's storage in a Cloudflare Worker. Values are plain JSON
// (amounts as decimal strings). Keys:
//
//   fleet            assignment cursor and per-worker counters (queued+running, running, done, earned)
//   ledger           the day's model spend and the running jobs' reservations (src/budget.mjs)
//   queue            ids of the paid jobs waiting for their worker, oldest first
//   quote:<id>       a quote: worker, minutes, price, payer (PRIORS), status
//   job:<id>         a job: task, payment, status, result, receipt fields
//   used:<txHash>    a PRIORS transaction that already paid for a job (kept forever)

/** An in-memory store (tests, and the base of the Node file store). */
export function memoryStore(initial = {}) {
  const m = new Map(Object.entries(structuredClone(initial)));
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { m.delete(k); },
    async list(prefix) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
    snapshot: () => Object.fromEntries(m),
  };
}

/**
 * One section at a time: every read-check-write of the state runs inside `lock(fn)`, so two requests can never both
 * spend the same quote, claim the same transaction hash, or reserve the same slice of the daily budget. (A Durable
 * Object runs one isolate, Node one thread; the lock orders the async sections within it.)
 */
export function mutex() {
  let tail = Promise.resolve();
  return function lock(fn) {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };
}
