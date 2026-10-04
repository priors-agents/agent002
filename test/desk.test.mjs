// Network-free tests of the service (src/desk.mjs) through its HTTP handler, as a buyer sees it: the manifest, the 402
// and its quote, a paid job and its receipt, the PRIORS path with its refusals, the daily cap refusing before any 402,
// and the jobs spreading over the three workers. The facilitator is a stand-in that checks the buyer's real EIP-3009
// signature; the chain is a stand-in JSON-RPC; the model is the deterministic stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, toX402Signer } from "@priors/x402";
import { makeDesk } from "../src/desk.mjs";
import { memoryStore } from "../src/store.mjs";
import { localRunner } from "../src/runner.mjs";
import { stubModel, STUB_COST_USD } from "../src/model.mjs";
import { settingsFromEnv } from "../src/settings.mjs";
import { USDG, PRIORS, TRANSFER_TOPIC } from "../src/chain.mjs";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } from "@x402/core/http";

const W = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
const env = (over = {}) => ({
  AGENT002_MODEL: "stub",
  AGENT002_WORKER_ADDRESS_1: W[0].address, AGENT002_WORKER_ADDRESS_2: W[1].address, AGENT002_WORKER_ADDRESS_3: W[2].address,
  AGENT002_WORKER_AGENT_ID_1: "9001",
  ...over,
});

/** A facilitator stand-in: checks the EIP-3009 signature, recipient and amount against the requirement it is given. */
function fakeFacilitator() {
  const settled = [];
  const check = (payload, req) => {
    const a = payload.payload.authorization;
    const domain = { name: req.extra.name, version: req.extra.version, chainId: 4663, verifyingContract: req.asset };
    const signer = ethers.verifyTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, a, payload.payload.signature);
    if (signer.toLowerCase() !== a.from.toLowerCase()) return { isValid: false, invalidReason: "invalid_signature" };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: "recipient_mismatch" };
    if (String(a.value) !== String(req.amount)) return { isValid: false, invalidReason: "value_mismatch" };
    return { isValid: true, payer: a.from };
  };
  return {
    settled,
    async verify(payload, req) { return check(payload, req); },
    async settle(payload, req) {
      const v = check(payload, req);
      if (!v.isValid) return { success: false, errorReason: v.invalidReason };
      const tx = ethers.hexlify(ethers.randomBytes(32));
      settled.push({ to: req.payTo, amount: req.amount, from: v.payer, tx });
      return { success: true, transaction: tx, network: "eip155:4663", payer: v.payer };
    },
  };
}

/** A buyer signing what a 402 asks, the way an x402 client does (EIP-3009 on USDG's domain). */
async function sign(buyer, req) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: buyer.address, to: req.payTo, value: req.amount, validAfter: String(now - 600), validBefore: String(now + req.maxTimeoutSeconds), nonce: ethers.hexlify(ethers.randomBytes(32)) };
  const s = toX402Signer(buyer);
  const signature = await s.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: 4663, verifyingContract: req.asset }, types: TRANSFER_WITH_AUTHORIZATION_TYPES, message: authorization });
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { authorization, signature } });
}

/** A chain stand-in: transactions by hash, a latest block that moves when told. */
function fakeChain() {
  const txs = new Map();
  let latest = 1000;
  let time = Math.floor(Date.now() / 1000);
  const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  return {
    mine(n = 1) { latest += n; time += n; },
    /** A PRIORS (or other token) transfer, mined now. */
    transfer({ token = PRIORS.address, from, to, value, status = 1 }) {
      const hash = ethers.hexlify(ethers.randomBytes(32));
      txs.set(hash, { tx: { hash, from }, receipt: { status: `0x${status}`, blockNumber: ethers.toQuantity(latest + 1), logs: status ? [{ address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: ethers.toBeHex(value, 32) }] : [] }, time: time + 1 });
      latest += 1; time += 1;
      return hash;
    },
    async rpc(method, params) {
      if (method === "eth_blockNumber") return ethers.toQuantity(latest);
      if (method === "eth_getTransactionByHash") return txs.get(params[0])?.tx ?? null;
      if (method === "eth_getTransactionReceipt") return txs.get(params[0])?.receipt ?? null;
      if (method === "eth_getBlockByNumber") { const t = [...txs.values()].find((x) => x.receipt.blockNumber === params[0]); return t ? { timestamp: ethers.toQuantity(t.time) } : null; }
      if (method === "eth_call") return "0x" + "0".repeat(64);
      throw new Error(`unexpected ${method}`);
    },
  };
}

function setup(over = {}, { modelFor = async () => stubModel(), facilitatorFor = null } = {}) {
  const settings = settingsFromEnv(env(over));
  const facilitator = fakeFacilitator();
  const chain = fakeChain();
  const store = memoryStore();
  const toolbox = () => ({ defs: async () => [], run: async () => ({ text: "", isError: true }) });
  const desk = makeDesk({ settings, store, runner: localRunner({ settings, toolbox, modelFor }), facilitatorFor: facilitatorFor ? (w) => facilitatorFor(w, facilitator) : () => facilitator, rpc: chain.rpc, sandbox: false });
  const call = (method, path, body, headers = {}) => desk.handle(new Request(`http://agent002.test${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { settings, facilitator, chain, store, desk, call };
}

async function waitDone(call, id) {
  for (let i = 0; i < 200; i++) {
    const j = await (await call("GET", `/jobs/${id}`)).json();
    if (j.status === "done" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} did not finish`);
}

test("manifest: the workers (id, agent id, wallet, record link), the rate in USDG and PRIORS, payment methods, minutes, jobs done", async () => {
  const { call } = setup();
  const r = await call("GET", "/manifest");
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.name, "agent002");
  assert.deepEqual(m.rate.perMinute, { USDG: "0.10", PRIORS: "25.00" });
  assert.deepEqual(m.minutes, { min: 1, max: 10 });
  assert.deepEqual(m.payment.map((p) => [p.token, p.method]), [["USDG", "x402"], ["PRIORS", "transfer"]]);
  assert.match(m.payment[0].payer, /EOA/);
  assert.deepEqual(m.workers.map((w) => [w.id, w.agentId, w.wallet, w.record, w.jobsDone]), [
    ["w1", 9001, W[0].address, "https://priors.trade/agent?id=9001", 0],
    ["w2", null, W[1].address, `https://priors.trade/agent?owner=${W[1].address}`, 0],
    ["w3", null, W[2].address, `https://priors.trade/agent?owner=${W[2].address}`, 0],
  ]);
  assert.equal(m.model.accepting, true);
  assert.deepEqual(await (await call("GET", "/")).json(), m);
});

test("USDG: unpaid -> 402 for exactly minutes x rate to the assigned worker; paid -> settled, run, result and receipt", async () => {
  const { call, facilitator } = setup();
  const buyer = ethers.Wallet.createRandom();
  const job = { minutes: 3, task: "Summarize what Priors is in one sentence." };
  const r402 = await call("POST", "/jobs", job);
  assert.equal(r402.status, 402);
  const pr = decodePaymentRequiredHeader(r402.headers.get("payment-required"));
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.accepts.length, 1);
  const req = pr.accepts[0];
  assert.deepEqual([req.scheme, req.network, req.asset, req.amount, req.payTo], ["exact", "eip155:4663", USDG.address, "300000", W[0].address]);
  assert.equal((await r402.json()).quote.worker.id, "w1");

  const signature = await sign(buyer, req);
  const paid = await call("POST", "/jobs", job, { "payment-signature": signature });
  assert.equal(paid.status, 201, await paid.clone().text());
  const settlement = decodePaymentResponseHeader(paid.headers.get("payment-response"));
  assert.equal(settlement.success, true);
  const created = await paid.json();
  assert.match(created.id, /^job_[0-9a-f]{32}$/);
  assert.deepEqual(facilitator.settled.map((s) => [s.to, s.amount, s.from]), [[W[0].address, "300000", buyer.address]]);

  const done = await waitDone(call, created.id);
  assert.equal(done.status, "done");
  assert.match(done.result, /stub answer .* "Summarize what Priors is in one sentence\."/);
  const rc = done.receipt;
  assert.deepEqual([rc.payer, rc.amount, rc.amountAtomic, rc.token, rc.method, rc.txHash, rc.worker, rc.workerId, rc.agentId, rc.minutesBought], [buyer.address, "0.30", "300000", "USDG", "x402", settlement.transaction, W[0].address, "w1", 9001, 3]);
  assert.ok(Date.parse(rc.startedAt) <= Date.parse(rc.finishedAt));
  assert.ok(rc.minutesUsed >= 0 && rc.minutesUsed <= 3);
  assert.equal(rc.modelSpendUsd, 2 * STUB_COST_USD);
  assert.equal(rc.model, "stub");
  assert.equal(rc.steps, 2);
  assert.equal(rc.toolCalls, 1);

  // the same signed payment sent again (a client retrying) returns the same job, and nothing is settled twice
  const resent = await call("POST", "/jobs", job, { "payment-signature": signature });
  assert.equal(resent.status, 200);
  assert.equal((await resent.json()).id, created.id);
  // a second, different payment for the used quote is refused
  const second = await call("POST", "/jobs", job, { "payment-signature": await sign(buyer, req) });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "quote_used");
  assert.equal(facilitator.settled.length, 1);
  const m = await (await call("GET", "/manifest")).json();
  assert.equal(m.workers[0].jobsDone, 1);
  assert.equal(m.workers[0].earned.USDG, "0.30");
});

test("USDG: a payment that does not match its quote is refused before anything settles", async () => {
  const { call, facilitator } = setup();
  const buyer = ethers.Wallet.createRandom();
  const job = { minutes: 2, task: "anything" };
  const req = decodePaymentRequiredHeader((await call("POST", "/jobs", job)).headers.get("payment-required")).accepts[0];
  // paying less, or another wallet, than the quote asked
  for (const tamper of [{ amount: "100000" }, { payTo: W[2].address }]) {
    const r = await call("POST", "/jobs", job, { "payment-signature": await sign(buyer, { ...req, ...tamper }) });
    assert.equal(r.status, 402, JSON.stringify(tamper));
    assert.equal((await r.json()).code, "requirement_mismatch");
  }
  // the quote's payment, for another job (more minutes)
  const other = await call("POST", "/jobs", { ...job, minutes: 5 }, { "payment-signature": await sign(buyer, req) });
  assert.equal(other.status, 400);
  assert.equal((await other.json()).code, "quote_mismatch");
  assert.equal(facilitator.settled.length, 0);
});

test("PRIORS: quote -> transfer to the quoted worker -> claim; then the reused hash and a short amount are refused", async () => {
  const { call, chain } = setup({ AGENT002_PRIORS_CONFIRMATIONS: "3" });
  const buyer = ethers.Wallet.createRandom().address;
  const q = await (await call("POST", "/quote", { minutes: 2, payer: buyer })).json();
  assert.equal(q.amount, "50.00");
  assert.equal(q.amountAtomic, (50n * 10n ** 18n).toString());
  assert.equal(q.token.address, PRIORS.address);
  const payTo = q.payTo;
  assert.ok(W.some((w) => w.address === payTo));

  const tx = chain.transfer({ from: buyer, to: payTo, value: BigInt(q.amountAtomic) });
  const claim = { minutes: 2, task: "Check agent 437's record.", quote: q.quote, payment: { token: "PRIORS", txHash: tx } };
  const early = await call("POST", "/jobs", claim);
  assert.equal(early.status, 409);
  assert.equal((await early.json()).code, "confirmations");
  chain.mine(3);
  const ok = await call("POST", "/jobs", claim);
  assert.equal(ok.status, 201, await ok.clone().text());
  const job = await waitDone(call, (await ok.json()).id);
  assert.deepEqual([job.receipt.token, job.receipt.amount, job.receipt.payer, job.receipt.worker, job.receipt.txHash, job.receipt.method], ["PRIORS", "50.00", buyer, payTo, tx, "transfer"]);

  // the same hash again, with a fresh quote: refused, it paid already
  const q2 = await (await call("POST", "/quote", { minutes: 2, payer: buyer })).json();
  const reused = await call("POST", "/jobs", { ...claim, quote: q2.quote });
  assert.equal(reused.status, 409);
  const rb = await reused.json();
  assert.equal(rb.code, "reused");
  assert.match(rb.error, new RegExp(job.id));

  // one wei short
  const short = chain.transfer({ from: buyer, to: q2.payTo, value: BigInt(q2.amountAtomic) - 1n });
  chain.mine(3);
  const r = await call("POST", "/jobs", { ...claim, quote: q2.quote, payment: { token: "PRIORS", txHash: short } });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).code, "short_amount");
});

test("PRIORS: wrong recipient, wrong token, failed transaction, wrong payer are refused, and none of them burns the quote", async () => {
  const { call, chain } = setup({ AGENT002_PRIORS_CONFIRMATIONS: "1" });
  const buyer = ethers.Wallet.createRandom().address;
  const q = await (await call("POST", "/quote", { minutes: 1, payer: buyer })).json();
  const notTheWorker = W.find((w) => w.address !== q.payTo).address;
  const value = BigInt(q.amountAtomic);
  const cases = [
    ["wrong_recipient", chain.transfer({ from: buyer, to: notTheWorker, value })],
    ["wrong_token", chain.transfer({ token: USDG.address, from: buyer, to: q.payTo, value })],
    ["failed_tx", chain.transfer({ from: buyer, to: q.payTo, value, status: 0 })],
    ["wrong_payer", chain.transfer({ from: notTheWorker, to: q.payTo, value })],
  ];
  chain.mine(2);
  for (const [code, txHash] of cases) {
    const r = await call("POST", "/jobs", { minutes: 1, task: "t", quote: q.quote, payment: { token: "PRIORS", txHash } });
    assert.equal(r.status, 402, code);
    assert.equal((await r.json()).code, code);
  }
  // the quote is still good for a proper payment
  const good = chain.transfer({ from: buyer, to: q.payTo, value });
  chain.mine(2);
  assert.equal((await call("POST", "/jobs", { minutes: 1, task: "t", quote: q.quote, payment: { token: "PRIORS", txHash: good } })).status, 201);
  // and USDG named as a transfer token is pointed at x402
  const bad = await call("POST", "/jobs", { minutes: 1, task: "t", payment: { token: "USDG", txHash: good } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /USDG is paid over x402/);
});

test("PRIORS: two claims of one transaction at the same time: exactly one job", async () => {
  const { call, chain } = setup({ AGENT002_PRIORS_CONFIRMATIONS: "1" });
  const buyer = ethers.Wallet.createRandom().address;
  const q1 = await (await call("POST", "/quote", { minutes: 1, payer: buyer })).json();
  const tx = chain.transfer({ from: buyer, to: q1.payTo, value: BigInt(q1.amountAtomic) });
  chain.mine(1);
  const body = { minutes: 1, task: "t", quote: q1.quote, payment: { token: "PRIORS", txHash: tx } };
  const rs = await Promise.all([call("POST", "/jobs", body), call("POST", "/jobs", body), call("POST", "/jobs", body)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
});

test("daily cap: once the day's model budget cannot hold another job, POST /jobs and POST /quote are refused with no 402", async () => {
  // a day of 2.5 jobs' caps: two running jobs hold 0.04 of 0.05, so a third does not fit until they finish
  let open;
  const gate = new Promise((r) => { open = r; });
  const gated = async () => { const m = stubModel(); return { ...m, complete: async (a) => { await gate; return m.complete(a); } }; };
  const { call, store, settings } = setup({ AGENT002_JOB_SPEND_CAP_USD: "0.02", AGENT002_DAILY_SPEND_CAP_USD: "0.05" }, { modelFor: gated });
  const buyer = ethers.Wallet.createRandom();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const job = { minutes: 1, task: `job ${i}` };
    const req = decodePaymentRequiredHeader((await call("POST", "/jobs", job)).headers.get("payment-required")).accepts[0];
    const r = await call("POST", "/jobs", job, { "payment-signature": await sign(buyer, req) });
    assert.equal(r.status, 201);
    ids.push((await r.json()).id);
  }
  assert.deepEqual(Object.values((await store.get("ledger")).reserved), [0.02, 0.02]);
  const held = await call("POST", "/jobs", { minutes: 1, task: "a third, while two run" });
  assert.equal(held.status, 503);
  assert.equal(held.headers.get("payment-required"), null);
  open();
  for (const id of ids) await waitDone(call, id);
  // once they finish, what they did not spend is free again: a third job gets its 402
  assert.equal((await call("POST", "/jobs", { minutes: 1, task: "a third, after" })).status, 402);
  // finished, they spent 2 x 2 stub calls; the reservations are released
  assert.equal((await store.get("ledger")).spentUsd, 4 * STUB_COST_USD);
  // fill the day with spend so that less than one job's cap is left
  await store.put("ledger", { ...(await store.get("ledger")), spentUsd: settings.dailySpendCapUsd - 0.01 });
  const refused = await call("POST", "/jobs", { minutes: 1, task: "one more" });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("payment-required"), null, "no 402, no payment asked");
  const body = await refused.json();
  assert.equal(body.code, "daily_cap");
  assert.match(body.error, /daily model budget is spent .* no new jobs until \d{4}-\d\d-\d\dT00:00:00\.000Z, nothing was charged/);
  const q = await call("POST", "/quote", { minutes: 1, payer: buyer.address });
  assert.equal(q.status, 503);
  const m = await (await call("GET", "/manifest")).json();
  assert.equal(m.model.accepting, false);
  assert.ok(m.model.reopensAt);
});

test("daily cap: a paid x402 request that no longer fits is refused before settlement (the buyer's authorization is not cashed)", async () => {
  const { call, store, settings, facilitator } = setup({ AGENT002_JOB_SPEND_CAP_USD: "0.02", AGENT002_DAILY_SPEND_CAP_USD: "0.05" });
  const buyer = ethers.Wallet.createRandom();
  const job = { minutes: 1, task: "late" };
  const req = decodePaymentRequiredHeader((await call("POST", "/jobs", job)).headers.get("payment-required")).accepts[0];
  await store.put("ledger", { day: new Date().toISOString().slice(0, 10), spentUsd: settings.dailySpendCapUsd - 0.01, reserved: {} });
  const r = await call("POST", "/jobs", job, { "payment-signature": await sign(buyer, req) });
  assert.equal(r.status, 503);
  assert.equal(facilitator.settled.length, 0);
});

test("fleet: jobs spread over all three workers, and each one earns exactly its jobs' prices", async () => {
  const { call, facilitator, chain } = setup({ AGENT002_PRIORS_CONFIRMATIONS: "1" });
  const buyer = ethers.Wallet.createRandom();
  const minutes = [1, 2, 3, 1];
  const jobs = [];
  for (const [i, n] of minutes.entries()) {
    const job = { minutes: n, task: `usdg job ${i}` };
    const req = decodePaymentRequiredHeader((await call("POST", "/jobs", job)).headers.get("payment-required")).accepts[0];
    jobs.push((await (await call("POST", "/jobs", job, { "payment-signature": await sign(buyer, req) })).json()).id);
  }
  const q = await (await call("POST", "/quote", { minutes: 2, payer: buyer.address })).json();
  const tx = chain.transfer({ from: buyer.address, to: q.payTo, value: BigInt(q.amountAtomic) });
  chain.mine(1);
  jobs.push((await (await call("POST", "/jobs", { minutes: 2, task: "priors job", quote: q.quote, payment: { token: "PRIORS", txHash: tx } })).json()).id);
  const done = [];
  for (const id of jobs) done.push(await waitDone(call, id));
  const by = {};
  for (const j of done) {
    by[j.worker.id] ??= { USDG: 0n, PRIORS: 0n, n: 0 };
    by[j.worker.id][j.receipt.token] += BigInt(j.receipt.amountAtomic);
    by[j.worker.id].n++;
  }
  assert.deepEqual(Object.keys(by).sort(), ["w1", "w2", "w3"], "every worker took at least one job");
  // what the facilitator moved to each wallet is exactly the sum of that worker's USDG jobs
  for (const [i, w] of W.entries()) {
    const moved = facilitator.settled.filter((s) => s.to === w.address).reduce((t, s) => t + BigInt(s.amount), 0n);
    assert.equal(moved, by[`w${i + 1}`].USDG);
  }
  const m = await (await call("GET", "/manifest")).json();
  assert.equal(m.workers.reduce((t, w) => t + w.jobsDone, 0), 5);
  for (const w of m.workers) assert.equal(w.jobsDone, by[w.id].n);
});

test("refusals: bad minutes, an empty task, a non-JSON body, an unknown job, a quote without payer", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/jobs", { minutes: 0, task: "x" })).status, 400);
  assert.equal((await call("POST", "/jobs", { minutes: 11, task: "x" })).status, 400);
  assert.equal((await call("POST", "/jobs", { minutes: 1, task: "" })).status, 400);
  const nonJson = await call("POST", "/jobs", undefined, {});
  assert.equal(nonJson.status, 400);
  assert.equal((await call("GET", "/jobs/job_" + "0".repeat(32))).status, 404);
  assert.equal((await call("GET", "/jobs/../../etc")).status, 404);
  assert.equal((await call("POST", "/quote", { minutes: 1 })).status, 400);
  assert.equal((await call("DELETE", "/jobs")).status, 404);
  const opt = await call("OPTIONS", "/jobs");
  assert.equal(opt.status, 204);
  assert.match(opt.headers.get("access-control-allow-headers"), /payment-signature/);
});

test("USDG needs a facilitator: a worker without one is never named in a 402; with none at all, 503 and no 402", async () => {
  const only3 = setup({}, { facilitatorFor: (w, f) => (w.id === "w3" ? f : null) });
  for (let i = 0; i < 3; i++) {
    const r = await only3.call("POST", "/jobs", { minutes: 1, task: `t${i}` });
    assert.equal(r.status, 402);
    assert.equal(decodePaymentRequiredHeader(r.headers.get("payment-required")).accepts[0].payTo, W[2].address);
  }
  const none = setup({}, { facilitatorFor: () => null });
  const r = await none.call("POST", "/jobs", { minutes: 1, task: "t" });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("payment-required"), null);
  assert.equal((await r.json()).code, "usdg_unavailable");
  assert.equal((await (await none.call("GET", "/manifest")).json()).payment[0].available, false);
  // PRIORS still works without any facilitator
  assert.equal((await none.call("POST", "/quote", { minutes: 1, payer: W[0].address })).status, 200);
});

test("a facilitator that fails mid-verification leaves no stuck quote and no held budget: the same payment can be sent again", async () => {
  let down = true;
  const { call, store, facilitator } = setup({}, { facilitatorFor: (w, f) => ({ verify: async (p, r) => { if (down) throw new TypeError("fetch failed"); return f.verify(p, r); }, settle: (p, r) => f.settle(p, r) }) });
  const buyer = ethers.Wallet.createRandom();
  const job = { minutes: 1, task: "retry me" };
  const req = decodePaymentRequiredHeader((await call("POST", "/jobs", job)).headers.get("payment-required")).accepts[0];
  const signature = await sign(buyer, req);
  const r1 = await call("POST", "/jobs", job, { "payment-signature": signature });
  assert.equal(r1.status, 502);
  assert.equal((await r1.json()).code, "facilitator_error");
  assert.deepEqual((await store.get("ledger")).reserved, {});
  assert.equal((await store.get(`quote:${req.extra.quote}`)).status, "open");
  down = false;
  const r2 = await call("POST", "/jobs", job, { "payment-signature": signature });
  assert.equal(r2.status, 201);
  assert.equal(facilitator.settled.length, 1);
});
