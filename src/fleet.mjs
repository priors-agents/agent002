// The fleet: three workers (or however many are configured), each with its own wallet, and one queue they share.
//
// A job is assigned to a worker before it is priced, because the price names who gets paid: the x402 402 asks the
// buyer to pay that worker's wallet, and a PRIORS quote tells the buyer which wallet to transfer to. Assignment is
// least-loaded (fewest jobs queued or running), and among equally loaded workers it goes round the fleet, starting
// after the worker that got the previous assignment. So jobs that arrive one at a time still spread over all three.

/**
 * The index of the worker the next job goes to.
 * @param {{ id: string }[]} workers
 * @param {Record<string, number>} load  jobs queued or running, by worker id
 * @param {number} last  index of the worker assigned last (-1 for none)
 */
export function pickWorker(workers, load, last = -1) {
  if (!workers.length) throw new Error("no workers configured");
  const n = workers.length;
  let best = -1;
  let bestLoad = Infinity;
  for (let k = 1; k <= n; k++) {
    const i = (((last + k) % n) + n) % n; // the worker after `last` first, so ties go round the fleet
    const l = Number(load[workers[i].id] || 0);
    if (l < bestLoad) { best = i; bestLoad = l; }
  }
  return best;
}

/** The public view of a worker: id, ERC-8004 agent id, wallet. Never its key. */
export function publicWorker(w) {
  return { id: w.id, agentId: w.agentId ?? null, wallet: w.address };
}
