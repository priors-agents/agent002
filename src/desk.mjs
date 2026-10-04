// The service, framework-free: one `handle(Request) -> Response` that runs the same in Node (src/server.mjs) and in a
// Cloudflare Worker (src/worker.mjs, inside the Desk Durable Object). It sells the workers' time:
//
//   GET  /manifest             (also GET /) who the workers are, the rate per minute in USDG and PRIORS, how to pay
//   POST /quote                {minutes, payer}: a PRIORS quote, so the buyer knows which worker's wallet to pay
//   POST /jobs                 {minutes, task}: unpaid -> 402 for minutes x rate USDG to the assigned worker (x402);
//                              paid (PAYMENT-SIGNATURE) -> settled, queued, 201 with the job id
//   POST /jobs                 {minutes, task, quote, payment: {token: "PRIORS", txHash}}: checked on chain, then queued
//   GET  /jobs/:id             status, result, and the receipt (payer, amount, token, tx, worker, times, model spend)
//
// A job is assigned before it is priced (src/fleet.mjs), so the payment lands in the wallet of the worker that does
// it. Paid jobs wait in one queue; each worker runs its own, one at a time, through `runner` (in-process in Node, a
// JobRunner Durable Object per job in a Worker), which calls finish() with the outcome. Before anything is quoted, the
// day's model budget must still hold a whole job (src/budget.mjs): when it does not, the request is refused with a
// 503 and no 402 is ever issued.
import { NETWORK, USDG, PRIORS, TOKENS, SOURCE, recordLink, isAddress, isTxHash } from "./chain.mjs";
import { BadRequest, checkMinutes, checkTask, priceFor, formatAtomic, usd8 } from "./money.mjs";
import { pickWorker, publicWorker } from "./fleet.mjs";
import { checkCanTakeJob, reserve, settleJob, availableUsd, DailyCapReached, nextUtcDay } from "./budget.mjs";
import { PaymentRefused, judgePriorsTransfer, readPriorsTransfer } from "./priors-pay.mjs";
import { requirementFor, paymentRequired, encodeRequired, encodeSettlement, readPayment, quoteIdOf, sameRequirement, authorizationNonce } from "./x402.mjs";
import { MCP_READ_TOOLS } from "./tools.mjs";
import { mutex } from "./store.mjs";
import { redact, safeMessage } from "./secrets.mjs";

const MAX_BODY = 16 * 1024;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, payment-signature",
  "access-control-expose-headers": "payment-required, payment-response",
};

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers } });
}

/** 128 random bits, hex: quote and job ids are unguessable, so only whoever holds one can read its job. */
export function randomId(prefix) {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// eth_call data for USDG's authorizationState(address authorizer, bytes32 nonce): EIP-3009's "was this used?"
const AUTHORIZATION_STATE = "0xe94a0102";

/**
 * @param {object} o
 * @param {object} o.settings        src/settings.mjs
 * @param {object} o.store           src/store.mjs interface
 * @param {{ start(job, hooks): Promise<void>|void }} o.runner
 * @param {(worker) => { verify, settle }} o.facilitatorFor   the x402 facilitator that settles payments to this worker
 * @param {(method, params) => Promise<any>} o.rpc            Robinhood Chain JSON-RPC (src/rpc.mjs)
 * @param {boolean} [o.sandbox]      a local fork: record links go by wallet
 */
export function makeDesk({ settings, store, runner, facilitatorFor, rpc, sandbox = false, now = () => Date.now(), log = null, newId = randomId }) {
  const lock = mutex();
  const workers = settings.workers;
  if (!workers.length) throw new Error("no workers: run `agent002 init`, or set AGENT002_WORKER_ADDRESS_1..3");
  const byId = new Map(workers.map((w) => [w.id, w]));
  const caps = { dailyCapUsd: settings.dailySpendCapUsd, jobCapUsd: settings.jobSpendCapUsd };
  let lastPrune = 0;

  const emptyFleet = () => ({ last: -1, workers: {} });
  const counters = (fleet, id) => (fleet.workers[id] ??= { active: 0, running: 0, done: 0, failed: 0, earned: { USDG: "0", PRIORS: "0" } });
  const getFleet = async () => (await store.get("fleet")) || emptyFleet();

  // ---- the manifest --------------------------------------------------------------------------------------------

  async function manifest(origin) {
    const fleet = await getFleet();
    const ledger = await store.get("ledger");
    const left = availableUsd(ledger, caps.dailyCapUsd, now());
    const t = now();
    return {
      name: "agent002",
      description: "A fleet of AI workers that sell their time by the minute on Robinhood Chain. Hire one for N minutes: pay N x the rate in USDG over x402, or in PRIORS by transfer; the payment lands in the wallet of the worker that does the job. Each worker runs an agent loop with read-only Priors tools, under a wall-clock limit of the minutes bought and a model-spend cap.",
      source: SOURCE,
      url: origin,
      chain: NETWORK,
      sandbox,
      rate: {
        perMinute: { USDG: formatAtomic(settings.rateUsdgAtomic, USDG.decimals), PRIORS: formatAtomic(settings.ratePriorsAtomic, PRIORS.decimals) },
        perMinuteAtomic: { USDG: settings.rateUsdgAtomic.toString(), PRIORS: settings.ratePriorsAtomic.toString() },
      },
      minutes: { min: settings.minMinutes, max: settings.maxMinutes },
      payment: [
        {
          token: "USDG", asset: USDG.address, decimals: USDG.decimals, method: "x402", x402Version: 2, scheme: "exact", network: NETWORK,
          transfer: "EIP-3009 transferWithAuthorization, signed by the buyer and settled by the facilitator",
          payer: "an EOA: the facilitator settles only EIP-3009 signatures from a plain key (no smart-contract wallets)",
          how: "POST /jobs {minutes, task} -> 402 whose PAYMENT-REQUIRED asks minutes x rate USDG to the assigned worker's wallet -> send the same request with PAYMENT-SIGNATURE",
        },
        {
          token: "PRIORS", asset: PRIORS.address, decimals: PRIORS.decimals, method: "transfer",
          confirmations: settings.priorsConfirmations, quoteValidSeconds: settings.priorsQuoteSeconds, claimWindowHours: settings.claimWindowHours,
          payer: "an EOA: the transfer's transaction must be sent by the payer the quote names",
          how: "POST /quote {minutes, payer} -> transfer the quoted amount of PRIORS to the quote's payTo -> POST /jobs {minutes, task, quote, payment: {token: \"PRIORS\", txHash}}",
        },
      ],
      workers: workers.map((w) => {
        const c = counters(fleet, w.id);
        return { ...publicWorker(w), record: recordLink({ agentId: w.agentId, wallet: w.address, sandbox }), jobsDone: c.done, jobsActive: c.active, earned: { USDG: formatAtomic(c.earned.USDG, USDG.decimals), PRIORS: formatAtomic(c.earned.PRIORS, PRIORS.decimals) } };
      }),
      model: { name: settings.model, jobSpendCapUsd: caps.jobCapUsd, dailySpendCapUsd: caps.dailyCapUsd, dailyLeftUsd: left, accepting: left + 1e-9 >= caps.jobCapUsd, ...(left + 1e-9 >= caps.jobCapUsd ? {} : { reopensAt: nextUtcDay(t) }) },
      tools: ["priors_check", ...MCP_READ_TOOLS, "time_left"],
      endpoints: { manifest: "GET /manifest", quote: "POST /quote", hire: "POST /jobs", job: "GET /jobs/{id}" },
    };
  }

  // ---- quotes ----------------------------------------------------------------------------------------------------

  /** Assign a worker and record a quote, inside the lock. Refuses (503) when the day's model budget is spent. */
  async function newQuote(fields) {
    return lock(async () => {
      checkCanTakeJob(await store.get("ledger"), caps, now()); // throws DailyCapReached: no quote, no 402
      const fleet = await getFleet();
      const load = Object.fromEntries(workers.map((w) => [w.id, counters(fleet, w.id).active]));
      const i = pickWorker(workers, load, fleet.last);
      fleet.last = i;
      const w = workers[i];
      const t = now();
      const quote = { id: newId("q"), workerId: w.id, payTo: w.address, createdAt: t, status: "open", ...fields(t) };
      await store.put("fleet", fleet);
      await store.put(`quote:${quote.id}`, quote);
      return { quote, worker: w };
    });
  }

  async function prune() {
    const t = now();
    if (t - lastPrune < 60_000) return;
    lastPrune = t;
    for (const [k, q] of await store.list("quote:")) {
      const keepUntil = q.method === "x402" ? q.expiresAt + 3600_000 : q.claimUntil;
      if (q.status === "open" && keepUntil < t) await store.delete(k);
    }
  }

  async function priorsQuote(request, url) {
    const body = request.method === "GET" ? Object.fromEntries(url.searchParams) : await readBody(request);
    const minutes = checkMinutes(body.minutes, settings);
    if (!isAddress(body.payer)) throw new BadRequest("payer: the address that will send the PRIORS transfer (an EOA); the quote is bound to it", "bad_payer");
    const amount = priceFor(minutes, settings.ratePriorsAtomic);
    await prune();
    const { quote, worker } = await newQuote((t) => ({
      method: "transfer", token: "PRIORS", minutes, amount: amount.toString(), payer: body.payer,
      expiresAt: t + settings.priorsQuoteSeconds * 1000, claimUntil: t + settings.claimWindowHours * 3600_000,
    }));
    log?.info?.(`quote ${quote.id}: ${minutes} min for ${formatAtomic(amount, PRIORS.decimals)} PRIORS to ${worker.id}`);
    return json(200, {
      quote: quote.id,
      worker: { ...publicWorker(worker), record: recordLink({ agentId: worker.agentId, wallet: worker.address, sandbox }) },
      minutes,
      token: { symbol: "PRIORS", address: PRIORS.address, decimals: PRIORS.decimals },
      payTo: worker.address,
      amount: formatAtomic(amount, PRIORS.decimals),
      amountAtomic: amount.toString(),
      payer: body.payer,
      expiresAt: new Date(quote.expiresAt).toISOString(),
      claimUntil: new Date(quote.claimUntil).toISOString(),
      confirmations: settings.priorsConfirmations,
      next: `transfer at least ${formatAtomic(amount, PRIORS.decimals)} PRIORS from ${body.payer} to ${worker.address} before ${new Date(quote.expiresAt).toISOString()}, then POST /jobs {"minutes": ${minutes}, "task": "...", "quote": "${quote.id}", "payment": {"token": "PRIORS", "txHash": "0x..."}}`,
    });
  }

  // ---- POST /jobs -------------------------------------------------------------------------------------------------

  async function postJob(request, url) {
    const body = await readBody(request);
    const minutes = checkMinutes(body.minutes, settings);
    const task = checkTask(body.task);
    if (body.payment !== undefined) return priorsJob(body, minutes, task);
    const payment = readPayment(request);
    const taskHash = await sha256Hex(task);
    const resource = `${settings.publicUrl ? settings.publicUrl.replace(/\/+$/, "") : url.origin}/jobs`;
    if (!payment) return usdgQuote({ minutes, taskHash, resource });
    return usdgPaid({ payment, minutes, task, taskHash });
  }

  /** Unpaid: assign a worker and answer 402 with the requirement for minutes x rate USDG to its wallet. */
  async function usdgQuote({ minutes, taskHash, resource }) {
    const amount = priceFor(minutes, settings.rateUsdgAtomic);
    await prune();
    const { quote, worker } = await newQuote((t) => ({ method: "x402", token: "USDG", minutes, amount: amount.toString(), taskHash, expiresAt: t + settings.x402QuoteSeconds * 1000 }));
    const requirement = requirementFor(quote, { maxTimeoutSeconds: settings.x402QuoteSeconds });
    const pr = paymentRequired({
      requirement,
      url: resource,
      description: `${minutes} minute(s) of agent002 worker ${worker.id}'s time: ${formatAtomic(amount, USDG.decimals)} USDG to ${worker.address}`,
      error: "PAYMENT-SIGNATURE header is required",
    });
    log?.info?.(`quote ${quote.id}: 402 for ${minutes} min, ${formatAtomic(amount, USDG.decimals)} USDG to ${worker.id}`);
    return json(402, { ...pr, quote: { id: quote.id, worker: publicWorker(worker), minutes, amount: formatAtomic(amount, USDG.decimals), token: "USDG", expiresAt: new Date(quote.expiresAt).toISOString() } }, { "payment-required": encodeRequired(pr) });
  }

  /** Paid: check the payment against the quote it names, reserve the job's model budget, verify, settle, queue. */
  async function usdgPaid({ payment, minutes, task, taskHash }) {
    const qid = quoteIdOf(payment);
    if (!qid) throw new PaymentRefused("no_quote", "the payment names no quote: send the request without payment for a 402, and pay what it asks");
    const nonce = authorizationNonce(payment);
    const claim = await lock(async () => {
      const quote = await store.get(`quote:${qid}`);
      if (!quote || quote.method !== "x402") throw new PaymentRefused("unknown_quote", "this payment's quote is unknown or expired: send the request without payment for a fresh 402");
      if (quote.status === "used") {
        if (quote.nonce && quote.nonce === nonce) return { existing: quote.jobId }; // the same payment, sent again
        throw new PaymentRefused("quote_used", "this quote was already paid for", { status: 409 });
      }
      if (quote.status === "settling") throw new PaymentRefused("settling", "this payment is being settled: send the same request again in a few seconds", { status: 409, retry: true });
      if (quote.status === "unsettled" && quote.nonce !== nonce) throw new PaymentRefused("unsettled", "this quote has a payment whose settlement is unconfirmed: send that same payment again to reconcile it", { status: 409 });
      if (quote.minutes !== minutes || quote.taskHash !== taskHash) throw new BadRequest("this payment's quote was for another job (other minutes or task): send this job unpaid for its own 402", "quote_mismatch");
      const requirement = requirementFor(quote, { maxTimeoutSeconds: settings.x402QuoteSeconds });
      if (!sameRequirement(payment.accepted, requirement)) throw new PaymentRefused("requirement_mismatch", "the payment does not accept the requirement this quote issued (amount, asset, network or payTo differ)");
      if (quote.status === "open" && quote.expiresAt < now()) throw new PaymentRefused("quote_expired", "this quote expired: send the request without payment for a fresh 402");
      const jobId = quote.jobId || newId("job");
      await store.put("ledger", reserve(await store.get("ledger"), jobId, caps, now())); // throws DailyCapReached: nothing settled
      const reconcile = quote.status === "unsettled";
      Object.assign(quote, { status: "settling", jobId, nonce });
      await store.put(`quote:${quote.id}`, quote);
      return { quote, requirement, jobId, reconcile };
    });
    if (claim.existing) {
      const job = await store.get(`job:${claim.existing}`);
      return json(200, jobView(job));
    }
    const { quote, requirement, jobId } = claim;
    const worker = byId.get(quote.workerId);
    const facilitator = facilitatorFor(worker);
    let settlement = null, payer = null;

    // a settlement whose outcome was unknown: if the authorization was used on chain, the payment landed
    if (claim.reconcile && (await authorizationUsed(payment))) {
      settlement = { success: true, transaction: null, network: NETWORK, payer: payment.payload.authorization.from, reconciled: true };
    }
    if (!settlement) {
      let v;
      try {
        v = await facilitator.verify(payment, requirement);
      } catch (e) {
        await reopen(quote, jobId, "open");
        throw Object.assign(new Error(`the facilitator did not answer the verification: ${safeMessage(e)}`), { status: 502, code: "facilitator_error" });
      }
      if (!v?.isValid) {
        await reopen(quote, jobId, "open");
        throw new PaymentRefused("invalid_payment", `the facilitator refused the payment: ${v?.invalidReason || "invalid"}${v?.invalidMessage ? ` (${String(v.invalidMessage).slice(0, 200)})` : ""}`);
      }
      payer = v.payer || null;
      try {
        settlement = await facilitator.settle(payment, requirement);
      } catch (e) {
        // the outcome is unknown: the authorization may have been cashed. The quote waits for the same payment again,
        // which is then reconciled against the chain (authorizationState) before anything is settled twice.
        await reopen(quote, jobId, "unsettled");
        throw Object.assign(new Error(`the facilitator did not confirm the settlement (${safeMessage(e)}): send the same paid request again to reconcile it`), { status: 502, code: "settlement_unknown" });
      }
      if (!settlement?.success) {
        await reopen(quote, jobId, "open");
        throw new PaymentRefused("settle_failed", `the payment did not settle: ${settlement?.errorReason || "failed"}`);
      }
    }
    const job = await lock(async () => {
      const t = now();
      const j = {
        id: jobId, status: "queued", workerId: worker.id, minutes, task, quoteId: quote.id, createdAt: t, modelSpendUsd: 0,
        payment: { method: "x402", token: "USDG", tokenAddress: USDG.address, amount: quote.amount, payer: settlement.payer || payer, txHash: settlement.transaction || null, network: settlement.network || NETWORK, paidAt: t, ...(settlement.reconciled ? { note: "reconciled from the chain: the settlement's transaction hash was not reported" } : {}) },
      };
      Object.assign(quote, { status: "used" });
      await store.put(`quote:${quote.id}`, quote);
      await enqueue(j);
      return j;
    });
    log?.info?.(`job ${job.id}: paid ${formatAtomic(job.payment.amount, USDG.decimals)} USDG to ${worker.id} (tx ${job.payment.txHash}), queued`);
    void dispatch();
    return json(201, jobView(job), { "payment-response": encodeSettlement({ success: true, transaction: job.payment.txHash || "", network: job.payment.network, payer: job.payment.payer }) });
  }

  async function reopen(quote, jobId, status) {
    await lock(async () => {
      const q = await store.get(`quote:${quote.id}`);
      if (q) { q.status = status; if (status === "open") { delete q.jobId; delete q.nonce; } await store.put(`quote:${q.id}`, q); }
      await store.put("ledger", settleJob(await store.get("ledger"), jobId, 0, now()));
    });
  }

  async function authorizationUsed(payment) {
    const a = payment?.payload?.authorization;
    if (!a || !isAddress(a.from) || !/^0x[0-9a-fA-F]{64}$/.test(String(a.nonce))) return false;
    try {
      const data = AUTHORIZATION_STATE + a.from.slice(2).toLowerCase().padStart(64, "0") + String(a.nonce).slice(2).toLowerCase();
      return BigInt(await rpc("eth_call", [{ to: USDG.address, data }, "latest"])) !== 0n;
    } catch (_) { return false; }
  }

  /** PRIORS: the transfer named by txHash pays for the quote, or the request is refused with the reason. */
  async function priorsJob(body, minutes, task) {
    const p = body.payment;
    if (!p || typeof p !== "object") throw new BadRequest("payment must be an object: {\"token\": \"PRIORS\", \"txHash\": \"0x...\"}", "bad_payment");
    if (p.token !== "PRIORS") throw new BadRequest("payment.token must be \"PRIORS\"; USDG is paid over x402 (send the request without payment for a 402)", "bad_token");
    if (!isTxHash(p.txHash)) throw new BadRequest("payment.txHash must be a transaction hash (0x and 64 hex digits)", "bad_tx_hash");
    const txHash = p.txHash.toLowerCase();
    const qid = body.quote ?? p.quote;
    if (typeof qid !== "string" || !qid) throw new BadRequest("quote: the id POST /quote gave before the transfer", "no_quote");

    const used = await store.get(`used:${txHash}`);
    if (used) throw new PaymentRefused("reused", `this transaction already paid for a job (${used.jobId}): a transfer pays once`, { status: 409 });
    const quote = await store.get(`quote:${qid}`);
    if (!quote || quote.method !== "transfer") throw new PaymentRefused("unknown_quote", "unknown quote: ask POST /quote before transferring", { status: 400 });
    if (quote.status === "used") throw new PaymentRefused("quote_used", `this quote was already paid for (job ${quote.jobId})`, { status: 409 });
    if (quote.minutes !== minutes) throw new BadRequest(`this quote is for ${quote.minutes} minute(s), not ${minutes}`, "quote_mismatch");
    if (now() > quote.claimUntil) throw new PaymentRefused("claim_window", `this quote could be claimed until ${new Date(quote.claimUntil).toISOString()}`);

    const chain = await readPriorsTransfer(rpc, txHash);
    const paid = judgePriorsTransfer({
      ...chain, token: PRIORS, payTo: quote.payTo, payer: quote.payer, minAmount: BigInt(quote.amount),
      minConfirmations: settings.priorsConfirmations,
      notBefore: Math.floor(quote.createdAt / 1000) - 2, notAfter: Math.ceil(quote.expiresAt / 1000),
    });

    const job = await lock(async () => {
      // again, inside the lock: two claims of one hash or one quote cannot both pass
      const again = await store.get(`used:${txHash}`);
      if (again) throw new PaymentRefused("reused", `this transaction already paid for a job (${again.jobId}): a transfer pays once`, { status: 409 });
      const q = await store.get(`quote:${qid}`);
      if (!q || q.status !== "open") throw new PaymentRefused("quote_used", "this quote was already paid for", { status: 409 });
      const jobId = newId("job");
      let ledger;
      try { ledger = reserve(await store.get("ledger"), jobId, caps, now()); } catch (e) {
        if (e instanceof DailyCapReached) throw new DailyCapReached(`${e.message.replace(/, nothing was charged$/, "")}. Your payment is valid and was not used: claim it again with the same request after ${nextUtcDay(now())} (until ${new Date(q.claimUntil).toISOString()})`);
        throw e;
      }
      const t = now();
      const j = {
        id: jobId, status: "queued", workerId: q.workerId, minutes, task, quoteId: q.id, createdAt: t, modelSpendUsd: 0,
        payment: { method: "transfer", token: "PRIORS", tokenAddress: PRIORS.address, amount: paid.amount.toString(), payer: paid.payer, txHash, network: NETWORK, blockNumber: paid.blockNumber, confirmations: paid.confirmations, paidAt: t },
      };
      await store.put("ledger", ledger);
      await store.put(`used:${txHash}`, { jobId, quoteId: q.id, at: t });
      Object.assign(q, { status: "used", jobId, txHash });
      await store.put(`quote:${q.id}`, q);
      await enqueue(j);
      return j;
    });
    log?.info?.(`job ${job.id}: paid ${formatAtomic(job.payment.amount, PRIORS.decimals)} PRIORS to ${job.workerId} (tx ${txHash}), queued`);
    void dispatch();
    return json(201, jobView(job));
  }

  // ---- the queue -------------------------------------------------------------------------------------------------

  /** Inside the lock: store the job, count it against its worker, put it at the back of the queue. */
  async function enqueue(job) {
    const fleet = await getFleet();
    counters(fleet, job.workerId).active++;
    const queue = (await store.get("queue")) || [];
    queue.push(job.id);
    await store.put(`job:${job.id}`, job);
    await store.put("fleet", fleet);
    await store.put("queue", queue);
  }

  /** Start every queued job whose worker has a free slot, oldest first. */
  async function dispatch() {
    const starting = await lock(async () => {
      const queue = (await store.get("queue")) || [];
      if (!queue.length) return [];
      const fleet = await getFleet();
      const out = [];
      const rest = [];
      for (const id of queue) {
        const job = await store.get(`job:${id}`);
        if (!job || job.status !== "queued") continue;
        const c = counters(fleet, job.workerId);
        if (c.running >= settings.workerConcurrency) { rest.push(id); continue; }
        c.running++;
        const t = now();
        job.status = "running";
        job.dispatchedAt = t;
        job.deadline ??= t + job.minutes * 60_000; // a resumed job keeps its first deadline
        await store.put(`job:${id}`, job);
        out.push(job);
      }
      await store.put("queue", rest);
      await store.put("fleet", fleet);
      return out;
    });
    for (const job of starting) {
      try {
        await runner.start(job, { finish, progress });
      } catch (e) {
        log?.error?.(`job ${job.id}: could not start (${safeMessage(e)}); back in the queue`);
        await lock(async () => {
          const j = await store.get(`job:${job.id}`);
          const fleet = await getFleet();
          if (j && j.status === "running") { j.status = "queued"; await store.put(`job:${j.id}`, j); counters(fleet, j.workerId).running--; }
          const queue = (await store.get("queue")) || [];
          await store.put("queue", [job.id, ...queue.filter((x) => x !== job.id)]);
          await store.put("fleet", fleet);
        });
      }
    }
  }

  /** What a running job has spent so far (kept, so a resumed job does not start its budget over). */
  async function progress(jobId, spentUsd) {
    await lock(async () => {
      const j = await store.get(`job:${jobId}`);
      if (j && j.status === "running") { j.modelSpendUsd = usd8(spentUsd); await store.put(`job:${jobId}`, j); }
    });
  }

  /** The runner's outcome: the job is done (or failed), its budget settled, its worker free for the next. */
  async function finish(jobId, outcome) {
    const done = await lock(async () => {
      const j = await store.get(`job:${jobId}`);
      if (!j || j.status === "done" || j.status === "failed") return null; // already finished: nothing twice
      const status = outcome.status === "done" ? "done" : "failed";
      Object.assign(j, {
        status,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        modelSpendUsd: usd8(outcome.modelSpendUsd ?? j.modelSpendUsd ?? 0),
        model: outcome.model ?? settings.model,
        steps: outcome.steps ?? 0,
        toolCalls: outcome.toolCalls ?? 0,
        stoppedBy: outcome.stoppedBy ?? null,
        startedAt: outcome.startedAt ?? new Date(j.dispatchedAt ?? now()).toISOString(),
        finishedAt: outcome.finishedAt ?? new Date(now()).toISOString(),
      });
      await store.put(`job:${jobId}`, j);
      await store.put("ledger", settleJob(await store.get("ledger"), jobId, j.modelSpendUsd, now()));
      const fleet = await getFleet();
      const c = counters(fleet, j.workerId);
      c.active = Math.max(0, c.active - 1);
      c.running = Math.max(0, c.running - 1);
      if (status === "done") c.done++; else c.failed++;
      c.earned[j.payment.token] = (BigInt(c.earned[j.payment.token] || "0") + BigInt(j.payment.amount)).toString();
      await store.put("fleet", fleet);
      return j;
    });
    if (done) log?.info?.(`job ${jobId}: ${done.status} on ${done.workerId}, model spend $${done.modelSpendUsd}${done.stoppedBy ? `, stopped by ${done.stoppedBy}` : ""}`);
    await dispatch();
  }

  /** After a restart (Node): jobs that were running go back to the front of the queue, with their spend so far. */
  async function recover() {
    await lock(async () => {
      const fleet = await getFleet();
      const back = [];
      for (const [, j] of await store.list("job:")) {
        if (j.status !== "running") continue;
        j.status = "queued";
        await store.put(`job:${j.id}`, j);
        back.push(j);
      }
      for (const w of workers) counters(fleet, w.id).running = 0;
      const queue = (await store.get("queue")) || [];
      await store.put("queue", [...back.sort((a, b) => a.createdAt - b.createdAt).map((j) => j.id), ...queue.filter((id) => !back.some((j) => j.id === id))]);
      await store.put("fleet", fleet);
    });
    await dispatch();
  }

  // ---- the job and its receipt -----------------------------------------------------------------------------------

  function jobView(j) {
    const w = byId.get(j.workerId) || { id: j.workerId, address: null, agentId: null };
    const token = TOKENS[j.payment.token];
    const started = j.startedAt ? Date.parse(j.startedAt) : null;
    const finished = j.finishedAt ? Date.parse(j.finishedAt) : null;
    return {
      id: j.id,
      status: j.status,
      minutes: j.minutes,
      task: j.task,
      worker: publicWorker(w),
      result: j.result ?? null,
      error: j.error ?? null,
      receipt: {
        payer: j.payment.payer,
        amount: formatAtomic(j.payment.amount, token.decimals),
        amountAtomic: j.payment.amount,
        token: j.payment.token,
        tokenAddress: j.payment.tokenAddress,
        method: j.payment.method,
        network: j.payment.network,
        txHash: j.payment.txHash,
        ...(j.payment.note ? { note: j.payment.note } : {}),
        worker: w.address,
        workerId: w.id,
        agentId: w.agentId ?? null,
        paidAt: new Date(j.payment.paidAt).toISOString(),
        startedAt: j.startedAt ?? null,
        finishedAt: j.finishedAt ?? null,
        minutesBought: j.minutes,
        minutesUsed: started !== null && finished !== null ? Math.round(((finished - started) / 60_000) * 100) / 100 : null,
        modelSpendUsd: j.modelSpendUsd ?? 0,
        model: j.model ?? settings.model,
        steps: j.steps ?? null,
        toolCalls: j.toolCalls ?? null,
        stoppedBy: j.stoppedBy ?? null,
      },
    };
  }

  async function getJob(id) {
    if (!/^job_[0-9a-f]{32}$/.test(id)) throw Object.assign(new Error("no such job"), { status: 404, code: "not_found" });
    const j = await store.get(`job:${id}`);
    if (!j) throw Object.assign(new Error("no such job"), { status: 404, code: "not_found" });
    return json(200, jobView(j));
  }

  // ---- HTTP --------------------------------------------------------------------------------------------------------

  async function readBody(request) {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_BODY) throw Object.assign(new Error(`the body is over ${MAX_BODY} bytes`), { status: 413, code: "too_large" });
    const text = await request.text();
    if (text.length > MAX_BODY) throw Object.assign(new Error(`the body is over ${MAX_BODY} bytes`), { status: 413, code: "too_large" });
    if (!text.trim()) return {};
    try {
      const b = JSON.parse(text);
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("not an object");
      return b;
    } catch (_) { throw new BadRequest("the body must be a JSON object, e.g. {\"minutes\": 2, \"task\": \"...\"}", "bad_json"); }
  }

  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (request.method === "GET" && (path === "/" || path === "/manifest")) return json(200, await manifest(settings.publicUrl || url.origin));
      if (path === "/quote" && (request.method === "POST" || request.method === "GET")) return await priorsQuote(request, url);
      if (path === "/jobs" && request.method === "POST") return await postJob(request, url);
      const m = /^\/jobs\/([^/]+)$/.exec(path);
      if (m && request.method === "GET") return await getJob(m[1]);
      return json(404, { error: "not found: see GET /manifest", code: "not_found" });
    } catch (e) {
      const expected = (e?.status >= 400 && e.status < 500) || e instanceof DailyCapReached || e?.status === 502;
      if (expected) {
        const headers = e?.retry ? { "retry-after": "3" } : {};
        return json(e.status || 400, { error: redact(e.message), code: e.code || "error", ...(e.retry ? { retry: true } : {}) }, headers);
      }
      log?.error?.(`${request.method} ${path}: ${safeMessage(e)}`);
      return json(500, { error: "internal error", code: "internal" });
    }
  }

  return { handle, finish, progress, recover, dispatch, manifest, jobView, store };
}
