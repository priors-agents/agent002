// Hire-only workers (AGENT002_HIRE_WORKERS) and jobs that name their worker (POST /jobs {agentId}): a hirer that picked
// an agent on a board pays that agent's wallet and gets that agent's time; jobs that name no worker stay with the
// numbered workers; a hire-only worker settles with AGENT002_HIRE_FACILITATOR_KEY's client. Network-free, as
// test/desk.test.mjs: the facilitator checks the buyer's real EIP-3009 signature, the model is the stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { settingsFromEnv, hireWorkersFromEnv } from "../src/settings.mjs";
import { redact } from "../src/secrets.mjs";
import { W, env, sign, setup, waitDone } from "./support.mjs";

const H = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
const HIRE = { AGENT002_HIRE_WORKERS: `20001:${H[0].address},20002:${H[1].address}`, AGENT002_HIRE_WORKERS_2: `20003:${H[2].address}` };
const required = (r) => decodePaymentRequiredHeader(r.headers.get("payment-required")).accepts[0];

test("settings: hire-only workers from AGENT002_HIRE_WORKERS and its continuations, after the numbered ones", () => {
  const s = settingsFromEnv(env(HIRE));
  assert.deepEqual(s.workers.map((w) => [w.id, w.agentId, w.address, !!w.hireOnly]), [
    ["w1", 9001, W[0].address, false], ["w2", null, W[1].address, false], ["w3", null, W[2].address, false],
    ["a20001", 20001, H[0].address, true], ["a20002", 20002, H[1].address, true], ["a20003", 20003, H[2].address, true],
  ]);
  assert.deepEqual(hireWorkersFromEnv({}), []);
  assert.throws(() => settingsFromEnv(env({ AGENT002_HIRE_WORKERS: "20001-0xabc" })), /not agentId:wallet/);
  assert.throws(() => settingsFromEnv(env({ AGENT002_HIRE_WORKERS: `20001:${H[0].address},20002:${H[0].address}` })), /share the wallet/);
  assert.throws(() => settingsFromEnv(env({ AGENT002_HIRE_WORKERS: `9001:${H[0].address}` })), /share the agent id 9001/);
  assert.throws(() => settingsFromEnv(env({ AGENT002_HIRE_WORKERS: `20001:${W[1].address}` })), /share the wallet/);
});

test("settings: AGENT002_HIRE_FACILITATOR_KEY is a secret, never printed", () => {
  const key = "hire-key-" + "x".repeat(40);
  const s = settingsFromEnv(env({ ...HIRE, AGENT002_HIRE_FACILITATOR_KEY: key }));
  assert.equal(s.hireFacilitatorKey, key);
  assert.ok(!redact(`the key is ${key}`).includes(key));
});

test("manifest: hire-only workers listed with their agent id and wallet (the hire format v1), marked hireOnly", async () => {
  const { call } = setup(HIRE);
  const m = await (await call("GET", "/manifest")).json();
  assert.deepEqual(m.workers.slice(3).map((w) => [w.id, w.agentId, w.wallet, w.hireOnly]), H.map((h, i) => [`a${20001 + i}`, 20001 + i, h.address, true]));
  assert.equal(m.workers[0].hireOnly, undefined);
  assert.equal(m.workers[3].record, undefined, "a hire-only worker's record link is its agent id's");
  assert.match(m.endpoints.hireWorker, /agentId/);
});

test("manifest: compact, so 250 workers stay far under the 64 KB a board reads", async () => {
  const many = Array.from({ length: 250 }, (_, i) => `${30000 + i}:${ethers.Wallet.createRandom().address}`);
  const { call } = setup({ AGENT002_HIRE_WORKERS: many.slice(0, 90).join(","), AGENT002_HIRE_WORKERS_2: many.slice(90, 180).join(","), AGENT002_HIRE_WORKERS_3: many.slice(180).join(",") });
  const text = await (await call("GET", "/manifest")).text();
  assert.equal(JSON.parse(text).workers.length, 253);
  assert.ok(!text.includes("\n"), "one line");
  assert.ok(text.length < 64 * 1024 * 0.85, `${text.length} bytes`);
});

test("POST /jobs {agentId}: the 402 pays that worker's wallet; paid, it runs on that worker and its receipt names it", async () => {
  const { call, facilitator } = setup(HIRE);
  const buyer = ethers.Wallet.createRandom();
  const job = { agentId: 20002, minutes: 1, task: "Say what Priors is in one sentence." };
  const r402 = await call("POST", "/jobs", job);
  assert.equal(r402.status, 402);
  const req = required(r402);
  assert.equal(req.payTo, H[1].address);
  assert.equal(req.amount, "100000");
  assert.equal((await r402.json()).quote.worker.agentId, 20002);
  const paid = await call("POST", "/jobs", job, { "payment-signature": await sign(buyer, req) });
  assert.equal(paid.status, 201, await paid.clone().text());
  const done = await waitDone(call, (await paid.json()).id);
  assert.equal(done.status, "done");
  assert.deepEqual([done.receipt.worker, done.receipt.agentId, done.receipt.workerId], [H[1].address, 20002, "a20002"]);
  assert.deepEqual(facilitator.settled.map((s) => [s.to, s.amount]), [[H[1].address, "100000"]]);
  const m = await (await call("GET", "/manifest")).json();
  assert.deepEqual(m.workers.filter((w) => w.jobsDone).map((w) => [w.agentId, w.earned.USDG]), [[20002, "0.10"]]);
  // a numbered worker can be named too
  assert.equal(required(await call("POST", "/jobs", { agentId: 9001, minutes: 1, task: "t" })).payTo, W[0].address);
  // as digits too
  assert.equal(required(await call("POST", "/jobs", { agentId: "20003", minutes: 1, task: "t" })).payTo, H[2].address);
});

test("POST /jobs {agentId}: an agent that is not a worker here is a 404, a bad id a 400, and neither gets a 402", async () => {
  const { call } = setup(HIRE);
  const r = await call("POST", "/jobs", { agentId: 77777, minutes: 1, task: "t" });
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("payment-required"), null);
  assert.equal((await r.json()).code, "unknown_worker");
  for (const agentId of [0, -1, 1.5, "abc", {}, true]) {
    const b = await call("POST", "/jobs", { agentId, minutes: 1, task: "t" });
    assert.equal(b.status, 400, String(agentId));
    assert.equal((await b.json()).code, "bad_agent");
  }
});

test("jobs that name no worker never go to a hire-only worker", async () => {
  const { call } = setup(HIRE);
  const pays = new Set();
  for (let i = 0; i < 9; i++) pays.add(required(await call("POST", "/jobs", { minutes: 1, task: `t${i}` })).payTo);
  assert.deepEqual([...pays].sort(), [W[0].address, W[1].address, W[2].address].sort());
  // a fleet of hire-only workers alone still takes jobs that name none
  const only = setup({ AGENT002_WORKER_ADDRESS_1: "", AGENT002_WORKER_ADDRESS_2: "", AGENT002_WORKER_ADDRESS_3: "", AGENT002_WORKER_AGENT_ID_1: "", ...HIRE });
  assert.ok(H.map((h) => h.address).includes(required(await only.call("POST", "/jobs", { minutes: 1, task: "t" })).payTo));
});

test("a payment for one worker's quote sent with another agentId is refused before anything settles", async () => {
  const { call, facilitator } = setup(HIRE);
  const buyer = ethers.Wallet.createRandom();
  const r402 = await call("POST", "/jobs", { agentId: 20001, minutes: 1, task: "t" });
  const sig = await sign(buyer, required(r402));
  const r = await call("POST", "/jobs", { agentId: 20002, minutes: 1, task: "t" }, { "payment-signature": sig });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "quote_mismatch");
  assert.equal(facilitator.settled.length, 0);
  // the same payment with its own agentId still goes through
  assert.equal((await call("POST", "/jobs", { agentId: 20001, minutes: 1, task: "t" }, { "payment-signature": sig })).status, 201);
});

test("a hire-only worker with no facilitator client is never named in a 402: 503, nothing asked", async () => {
  const { call } = setup(HIRE, { facilitatorFor: (w, f) => (w.hireOnly ? null : f) });
  const r = await call("POST", "/jobs", { agentId: 20001, minutes: 1, task: "t" });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("payment-required"), null);
  assert.equal((await r.json()).code, "usdg_unavailable");
});

test("POST /quote {agentId}: a PRIORS quote pays that worker's wallet", async () => {
  const { call } = setup(HIRE);
  const q = await (await call("POST", "/quote", { minutes: 1, payer: W[0].address, agentId: 20003 })).json();
  assert.equal(q.payTo, H[2].address);
  assert.equal(q.worker.agentId, 20003);
});

test("daily cap: a job naming a worker is refused like any other once the day's model budget is spent, with no 402", async () => {
  const { call } = setup({ ...HIRE, AGENT002_DAILY_SPEND_CAP_USD: "0.05", AGENT002_JOB_SPEND_CAP_USD: "0.05" });
  const buyer = ethers.Wallet.createRandom();
  const job = { agentId: 20001, minutes: 1, task: "t" };
  const paid = await call("POST", "/jobs", job, { "payment-signature": await sign(buyer, required(await call("POST", "/jobs", job))) });
  assert.equal(paid.status, 201);
  const r = await call("POST", "/jobs", { agentId: 20002, minutes: 1, task: "t" });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("payment-required"), null);
  assert.equal((await r.json()).code, "daily_cap");
});
