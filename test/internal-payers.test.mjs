// Internal payers (AGENT002_INTERNAL_PAYERS): wallets of the operator itself. A job one of them pays is quoted, paid,
// settled, run and answered like any other, and its worker is paid as for any other; the manifest's public counters
// leave it out: a worker's jobsDone, jobsActive and earned count the jobs that others paid for. The list is the
// operator's own: nothing the service answers names it. Network-free, as test/desk.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { settingsFromEnv } from "../src/settings.mjs";
import { stubModel } from "../src/model.mjs";
import { env, sign, setup, waitDone } from "./support.mjs";

const required = (r) => decodePaymentRequiredHeader(r.headers.get("payment-required")).accepts[0];
const own = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
const OWN = { AGENT002_INTERNAL_PAYERS: `${own[0].address},${own[1].address.toLowerCase()}`, AGENT002_INTERNAL_PAYERS_2: own[2].address };
const H = ethers.Wallet.createRandom();
const HIRE = { AGENT002_HIRE_WORKERS: `20001:${H.address}` };
const task = "Say what Priors is in one sentence.";

/** One paid USDG job: the 402, then the same request paid; returns the requirement and the finished job. */
async function hire(call, buyer, body) {
  const req = required(await call("POST", "/jobs", body));
  const paid = await call("POST", "/jobs", body, { "payment-signature": await sign(buyer, req) });
  assert.equal(paid.status, 201, await paid.clone().text());
  return { req, id: (await paid.json()).id };
}
const manifestOf = async (call) => (await call("GET", "/manifest")).json();
const workerOf = (m, wallet) => m.workers.find((w) => w.wallet === wallet);

test("settings: AGENT002_INTERNAL_PAYERS and its continuations, as lower-case addresses; none by default; a bad entry stops the service", () => {
  const s = settingsFromEnv(env(OWN));
  assert.deepEqual([...s.internalPayers].sort(), own.map((w) => w.address.toLowerCase()).sort());
  assert.equal(settingsFromEnv(env()).internalPayers.size, 0);
  assert.throws(() => settingsFromEnv(env({ AGENT002_INTERNAL_PAYERS: "0x123" })), /AGENT002_INTERNAL_PAYERS: .* is not an address/);
  assert.throws(() => settingsFromEnv(env({ AGENT002_INTERNAL_PAYERS_3: "agent" })), /AGENT002_INTERNAL_PAYERS_3/);
});

test("USDG: a job an internal payer pays runs, settles and is answered as any other; the worker's public counters leave it out, another buyer's job counts", async () => {
  const { call, facilitator } = setup(OWN);
  const first = await hire(call, own[0], { minutes: 1, task });
  const done = await waitDone(call, first.id);
  assert.equal(done.status, "done");
  assert.equal(done.receipt.payer.toLowerCase(), own[0].address.toLowerCase());
  assert.equal(done.receipt.amount, "0.10");
  assert.deepEqual(facilitator.settled.map((s) => [s.to, s.amount]), [[first.req.payTo, "100000"]], "the worker is paid as for any job");
  let m = await manifestOf(call);
  assert.deepEqual(m.workers.map((w) => [w.jobsDone, w.jobsActive, w.earned.USDG]), m.workers.map(() => [0, 0, "0.00"]));

  const buyer = ethers.Wallet.createRandom();
  const second = await hire(call, buyer, { minutes: 1, task });
  await waitDone(call, second.id);
  m = await manifestOf(call);
  assert.equal(m.workers.reduce((t, w) => t + w.jobsDone, 0), 1, "only the other buyer's job");
  assert.deepEqual([workerOf(m, second.req.payTo).jobsDone, workerOf(m, second.req.payTo).earned.USDG], [1, "0.10"]);
});

test("a hire-only worker named by the job (the hire format's POST /jobs {agentId}): paid at its wallet, run on it, and not counted when an internal payer hires it", async () => {
  const { call, facilitator } = setup({ ...OWN, ...HIRE });
  const h = await hire(call, own[1], { agentId: 20001, minutes: 1, task });
  assert.equal(h.req.payTo, H.address);
  const done = await waitDone(call, h.id);
  assert.deepEqual([done.status, done.receipt.agentId], ["done", 20001]);
  assert.deepEqual(facilitator.settled.map((s) => s.to), [H.address]);
  const w = workerOf(await manifestOf(call), H.address);
  assert.deepEqual([w.jobsDone, w.jobsActive, w.earned.USDG], [0, 0, "0.00"]);
});

test("PRIORS: a transfer from an internal payer buys a job that runs, and the worker's public counters leave it out", async () => {
  const { call, chain } = setup({ ...OWN, AGENT002_PRIORS_CONFIRMATIONS: "1" });
  const q = await (await call("POST", "/quote", { minutes: 1, payer: own[2].address })).json();
  const tx = chain.transfer({ from: own[2].address, to: q.payTo, value: BigInt(q.amountAtomic) });
  chain.mine(1);
  const ok = await call("POST", "/jobs", { minutes: 1, task, quote: q.quote, payment: { token: "PRIORS", txHash: tx } });
  assert.equal(ok.status, 201, await ok.clone().text());
  assert.equal((await waitDone(call, (await ok.json()).id)).status, "done");
  const w = workerOf(await manifestOf(call), q.payTo);
  assert.deepEqual([w.jobsDone, w.earned.PRIORS], [0, "0.00"]);
});

test("while it runs, an internal payer's job takes its worker's slot (the next job waits for it) but is not in the public jobsActive", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { const m = stubModel(); return { ...m, complete: async (o) => { await gate; return m.complete(o); } }; };
  const { call } = setup({ ...OWN, ...HIRE }, { modelFor: slow });
  const internal = await hire(call, own[0], { agentId: 20001, minutes: 1, task });
  const outside = await hire(call, ethers.Wallet.createRandom(), { agentId: 20001, minutes: 1, task });
  await new Promise((r) => setTimeout(r, 30));
  const w = workerOf(await manifestOf(call), H.address);
  assert.equal(w.jobsActive, 1, "the other buyer's job only");
  assert.equal((await (await call("GET", `/jobs/${outside.id}`)).json()).status, "queued", "the internal job holds the worker's one slot");
  release();
  await waitDone(call, internal.id);
  await waitDone(call, outside.id);
  const after = workerOf(await manifestOf(call), H.address);
  assert.deepEqual([after.jobsDone, after.jobsActive, after.earned.USDG], [1, 0, "0.10"]);
});

test("nothing the service answers names an internal payer: not the manifest, not a job (its receipt names its own payer only)", async () => {
  const { call } = setup({ ...OWN, ...HIRE });
  const h = await hire(call, ethers.Wallet.createRandom(), { minutes: 1, task });
  await waitDone(call, h.id);
  const texts = [JSON.stringify(await manifestOf(call)), await (await call("GET", `/jobs/${h.id}`)).text(), await (await call("GET", "/recipes")).text()];
  for (const t of texts) for (const o of own) assert.ok(!t.toLowerCase().includes(o.address.slice(2).toLowerCase()), "an internal payer named");
  for (const t of texts) assert.doesNotMatch(t, /internal/i);
});
