// Network-free tests of the rules: prices, worker assignment, the PRIORS payment checks, the daily model budget, the
// x402 requirement, the settings, and the constants agent002 shares with @priors/x402.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { robinhood } from "@priors/x402";
import { USDG, PRIORS, REGISTRY, NETWORK, TRANSFER_TOPIC, recordLink } from "../src/chain.mjs";
import { toAtomic, formatAtomic, priceFor, checkMinutes, checkTask, BadRequest } from "../src/money.mjs";
import { pickWorker } from "../src/fleet.mjs";
import { judgePriorsTransfer, transfersIn, PaymentRefused } from "../src/priors-pay.mjs";
import { rollLedger, availableUsd, checkCanTakeJob, reserve, settleJob, DailyCapReached, nextUtcDay } from "../src/budget.mjs";
import { requirementFor, sameRequirement, readPayment, quoteIdOf } from "../src/x402.mjs";
import { settingsFromEnv, workersFromEnv } from "../src/settings.mjs";
import { addSecret, redact } from "../src/secrets.mjs";

test("the token and registry addresses are the ones @priors/x402 ships (deployments/4663.v2.json)", () => {
  assert.equal(USDG.address, robinhood.usdg);
  assert.equal(USDG.decimals, robinhood.usdgDecimals);
  assert.deepEqual({ ...USDG.eip712 }, { ...robinhood.eip712 });
  assert.equal(REGISTRY, robinhood.registry);
  assert.equal(NETWORK, robinhood.network);
  assert.equal(PRIORS.address, ethers.getAddress(PRIORS.address)); // checksummed, as in the deployment record
  assert.equal(TRANSFER_TOPIC, ethers.id("Transfer(address,address,uint256)"));
});

test("pricing: exactly minutes x rate, in each token's smallest unit, no rounding", () => {
  const usdg = toAtomic("0.10", 6);
  const priors = toAtomic("25", 18);
  assert.equal(usdg, 100_000n);
  assert.equal(priceFor(3, usdg), 300_000n);
  assert.equal(priceFor(7, priors), 175n * 10n ** 18n);
  assert.equal(formatAtomic(300_000n, 6), "0.30");
  assert.equal(formatAtomic(175n * 10n ** 18n, 18), "175.00");
  assert.equal(formatAtomic(1n, 18), "0.000000000000000001");
  assert.equal(toAtomic("0.000001", 6), 1n);
  assert.throws(() => toAtomic("0.0000001", 6), /more than 6 decimals/);
  assert.throws(() => toAtomic("-1", 6), /decimal number/);
  assert.throws(() => toAtomic("1e3", 6), /decimal number/);
});

test("minutes: whole minutes within the limits; task: a bounded non-empty string", () => {
  const lim = { minMinutes: 1, maxMinutes: 10 };
  assert.equal(checkMinutes(1, lim), 1);
  assert.equal(checkMinutes(10, lim), 10);
  assert.equal(checkMinutes("3", lim), 3);
  for (const bad of [0, 11, 2.5, -1, "two", null, undefined, "1e1"]) assert.throws(() => checkMinutes(bad, lim), BadRequest, String(bad));
  assert.equal(checkTask("  do it  "), "do it");
  assert.throws(() => checkTask(""), /non-empty/);
  assert.throws(() => checkTask(42), /non-empty/);
  assert.throws(() => checkTask("x".repeat(4001)), /at most 4000/);
});

test("assignment: least loaded first; ties go round the fleet after the last one assigned", () => {
  const ws = [{ id: "w1" }, { id: "w2" }, { id: "w3" }];
  // all idle: round robin from the start
  let last = -1;
  const order = [];
  for (let i = 0; i < 6; i++) { last = pickWorker(ws, {}, last); order.push(ws[last].id); }
  assert.deepEqual(order, ["w1", "w2", "w3", "w1", "w2", "w3"]);
  // the least loaded wins whatever the cursor says
  assert.equal(pickWorker(ws, { w1: 2, w2: 0, w3: 1 }, 1), 1);
  assert.equal(pickWorker(ws, { w1: 1, w2: 1, w3: 0 }, -1), 2);
  // among equally loaded, the one after the cursor
  assert.equal(pickWorker(ws, { w1: 0, w2: 1, w3: 0 }, 0), 2);
  assert.equal(pickWorker(ws, { w1: 0, w2: 1, w3: 0 }, 2), 0);
  assert.throws(() => pickWorker([], {}, -1), /no workers/);
});

// ---- PRIORS verification ------------------------------------------------------------------------------------------

const worker = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const transferLog = (token, from, to, value) => ({ address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: ethers.toBeHex(value, 32), removed: false });
const price = 50n * 10n ** 18n;
const base = (logs, over = {}) => ({
  tx: { from: payer, hash: "0xaa" },
  receipt: { status: "0x1", blockNumber: "0x64", logs },
  latestBlock: 120,
  blockTime: 1_800_000_100,
  token: PRIORS,
  payTo: worker,
  payer,
  minAmount: price,
  minConfirmations: 20,
  notBefore: 1_800_000_000,
  notAfter: 1_800_001_800,
  ...over,
});
const refusedWith = (code) => (e) => e instanceof PaymentRefused && e.code === code;

test("PRIORS: a successful transfer of at least the price to the assigned worker, from the quoted payer, is accepted", () => {
  const r = judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price)]));
  assert.equal(r.amount, price);
  assert.equal(r.payer, payer);
  assert.equal(r.confirmations, 21);
  // more than the price is fine, and several transfers to the worker in one transaction add up
  const split = judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price / 2n), transferLog(PRIORS.address, payer, worker, price / 2n + 1n)]));
  assert.equal(split.amount, price + 1n);
});

test("PRIORS: a short amount is refused, even by one wei", () => {
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price - 1n)])), (e) => refusedWith("short_amount")(e) && /paid 49\.999999999999999999 PRIORS; the price is 50\.00 PRIORS/.test(e.message));
});

test("PRIORS: a transfer to another wallet than the assigned worker's is refused (the part to the worker counts, the rest does not)", () => {
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, other, price)])), (e) => refusedWith("wrong_recipient")(e) && e.message.includes(worker));
  // half to the worker, half elsewhere: short
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price / 2n), transferLog(PRIORS.address, payer, other, price / 2n)])), refusedWith("short_amount"));
});

test("PRIORS: another token's transfer, however large, is refused (the event must come from the PRIORS contract)", () => {
  assert.throws(() => judgePriorsTransfer(base([transferLog(USDG.address, payer, worker, price * 1000n)])), (e) => refusedWith("wrong_token")(e) && e.message.includes(USDG.address));
  assert.throws(() => judgePriorsTransfer(base([])), refusedWith("wrong_token"));
  // a removed (reorged) log does not count
  const removed = { ...transferLog(PRIORS.address, payer, worker, price), removed: true };
  assert.throws(() => judgePriorsTransfer(base([removed])), refusedWith("wrong_token"));
});

test("PRIORS: a failed (reverted) transaction is refused; one not mined yet is 'try again'", () => {
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price)], { receipt: { status: "0x0", blockNumber: "0x64", logs: [] } })), refusedWith("failed_tx"));
  assert.throws(() => judgePriorsTransfer(base([], { receipt: null })), (e) => refusedWith("not_mined")(e) && e.retry === true && e.status === 409);
});

test("PRIORS: the sender must be the quote's payer; the transfer must fall inside the quote's window", () => {
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price)], { tx: { from: other } })), refusedWith("wrong_payer"));
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price)], { blockTime: 1_799_999_999 })), refusedWith("before_quote"));
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price)], { blockTime: 1_800_001_801 })), refusedWith("quote_expired"));
});

test("PRIORS: too few confirmations is 'try again', not a refusal for good", () => {
  assert.throws(() => judgePriorsTransfer(base([transferLog(PRIORS.address, payer, worker, price)], { latestBlock: 105 })), (e) => refusedWith("confirmations")(e) && e.retry && /6 confirmation\(s\); 20 are needed/.test(e.message));
});

test("transfersIn reads only well-formed ERC-20 Transfer events", () => {
  const approval = { address: PRIORS.address, topics: [ethers.id("Approval(address,address,uint256)"), word(payer), word(worker)], data: ethers.toBeHex(5, 32) };
  const nft = { address: REGISTRY, topics: [TRANSFER_TOPIC, word(payer), word(worker), ethers.toBeHex(7, 32)], data: "0x" };
  assert.deepEqual(transfersIn({ logs: [approval, nft, transferLog(PRIORS.address, payer, worker, 9n)] }).map((t) => t.value), [9n]);
});

// ---- the daily model budget ----------------------------------------------------------------------------------------

test("daily cap: a job is taken only while a whole per-job cap fits; running jobs hold theirs; a new UTC day starts over", () => {
  const caps = { dailyCapUsd: 0.12, jobCapUsd: 0.05 };
  const t = Date.parse("2026-10-04T10:00:00Z");
  let l = rollLedger(null, t);
  l = reserve(l, "a", caps, t);
  l = reserve(l, "b", caps, t);
  assert.equal(availableUsd(l, caps.dailyCapUsd, t), 0.02);
  assert.throws(() => reserve(l, "c", caps, t), (e) => e instanceof DailyCapReached && e.status === 503 && /no new jobs until 2026-10-05T00:00:00.000Z, nothing was charged/.test(e.message));
  // a finished job gives back what it did not spend
  l = settleJob(l, "a", 0.004, t);
  assert.equal(availableUsd(l, caps.dailyCapUsd, t), 0.066);
  checkCanTakeJob(l, caps, t);
  l = reserve(l, "c", caps, t);
  l = settleJob(l, "b", 0.05, t);
  l = settleJob(l, "c", 0.05, t);
  assert.equal(l.spentUsd, 0.104);
  assert.throws(() => checkCanTakeJob(l, caps, t), DailyCapReached);
  // the next UTC day: nothing spent yet
  const tomorrow = Date.parse("2026-10-05T00:00:01Z");
  assert.equal(availableUsd(l, caps.dailyCapUsd, tomorrow), 0.12);
  assert.equal(nextUtcDay(t), "2026-10-05T00:00:00.000Z");
});

test("daily cap: a reservation from yesterday still counts today until its job finishes", () => {
  const caps = { dailyCapUsd: 0.1, jobCapUsd: 0.05 };
  let l = reserve(null, "late", caps, Date.parse("2026-10-04T23:59:00Z"));
  const today = Date.parse("2026-10-05T00:01:00Z");
  assert.equal(availableUsd(l, caps.dailyCapUsd, today), 0.05);
  l = settleJob(l, "late", 0.01, today);
  assert.equal(availableUsd(l, caps.dailyCapUsd, today), 0.09);
});

// ---- x402 ----------------------------------------------------------------------------------------------------------

test("x402: the requirement is the quote's amount to the quote's worker, with the quote id; a changed field does not match", () => {
  const q = { id: "q_1", amount: "300000", payTo: worker };
  const req = requirementFor(q, { maxTimeoutSeconds: 300 });
  assert.deepEqual(req, { scheme: "exact", network: "eip155:4663", asset: USDG.address, amount: "300000", payTo: worker, maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1", quote: "q_1" } });
  assert.ok(sameRequirement({ ...req, asset: USDG.address.toLowerCase() }, req));
  for (const change of [{ amount: "200000" }, { payTo: other }, { asset: PRIORS.address }, { network: "eip155:1" }, { extra: { ...req.extra, quote: "q_2" } }]) {
    assert.equal(sameRequirement({ ...req, ...change }, req), false, JSON.stringify(change));
  }
  assert.equal(quoteIdOf({ accepted: req }), "q_1");
});

test("x402: a v1 X-PAYMENT header is refused with a reason; a garbled PAYMENT-SIGNATURE too", () => {
  assert.equal(readPayment(new Request("http://x/jobs", { method: "POST" })), null);
  assert.throws(() => readPayment(new Request("http://x/jobs", { method: "POST", headers: { "x-payment": "abc" } })), /v1 \(X-PAYMENT\) is not accepted/);
  assert.throws(() => readPayment(new Request("http://x/jobs", { method: "POST", headers: { "payment-signature": "%%%" } })), /not a base64 x402 payment/);
  const v1 = Buffer.from(JSON.stringify({ x402Version: 1, payload: {} })).toString("base64");
  assert.throws(() => readPayment(new Request("http://x/jobs", { method: "POST", headers: { "payment-signature": v1 } })), /not an x402 v2 payment/);
});

test("USDG's authorizationState selector, used to reconcile a settlement whose outcome was unknown", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/desk.mjs", import.meta.url), "utf8"));
  const sel = /AUTHORIZATION_STATE = "(0x[0-9a-f]{8})"/.exec(src)[1];
  assert.equal(sel, ethers.id("authorizationState(address,bytes32)").slice(0, 10));
});

// ---- settings ------------------------------------------------------------------------------------------------------

test("settings: defaults, rates in atomic units, the caps' consistency, workers by key or by address", () => {
  const s = settingsFromEnv({});
  assert.equal(s.rateUsdgAtomic, 100_000n);
  assert.equal(s.ratePriorsAtomic, 25n * 10n ** 18n);
  assert.equal(s.jobSpendCapUsd, 0.05);
  assert.equal(s.dailySpendCapUsd, 3);
  assert.equal(s.model, "openai/gpt-6-luna");
  assert.deepEqual(s.workers, []);
  assert.throws(() => settingsFromEnv({ AGENT002_JOB_SPEND_CAP_USD: "5", AGENT002_DAILY_SPEND_CAP_USD: "3" }), /cannot be above/);
  assert.throws(() => settingsFromEnv({ AGENT002_RATE_USDG: "0" }), /above zero/);
  assert.throws(() => settingsFromEnv({ AGENT002_MAX_MINUTES: "0" }), /at least 1/);

  const k = ethers.Wallet.createRandom();
  const ws = workersFromEnv({ AGENT002_WORKER_KEY_1: k.privateKey, AGENT002_WORKER_ADDRESS_2: other, AGENT002_WORKER_AGENT_ID_2: "812" });
  assert.deepEqual(ws.map((w) => [w.id, w.address, w.agentId]), [["w1", k.address, null], ["w2", ethers.getAddress(other), 812]]);
  assert.equal(redact(`key ${k.privateKey}`), "key <redacted>", "a worker key read from the environment is registered for redaction");
  assert.throws(() => workersFromEnv({ AGENT002_WORKER_KEY_1: k.privateKey, AGENT002_WORKER_ADDRESS_1: other }), /is not the address of/);
  assert.throws(() => settingsFromEnv({ AGENT002_WORKER_ADDRESS_1: other, AGENT002_WORKER_ADDRESS_2: other }), /share the wallet/);
});

test("settings: the OpenRouter key, facilitator keys and a private RPC URL are redacted; a local fork's URL is not", () => {
  const orKey = ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-"); // the shape of an OpenRouter key, not one
  const fac = "fac_" + "z".repeat(40);
  const rpc = "https://example-node.invalid/" + "f".repeat(32) + "/";
  settingsFromEnv({ OPENROUTER_API_KEY: orKey, AGENT002_FACILITATOR_KEY_1: fac, AGENT002_RPC: rpc });
  assert.equal(redact(`${orKey} ${fac} ${rpc}`), "<redacted> <redacted> <redacted>");
  settingsFromEnv({ AGENT002_RPC: "http://127.0.0.1:8545" });
  assert.equal(redact("http://127.0.0.1:8545"), "http://127.0.0.1:8545");
  addSecret("short"); // too short to register: it would redact ordinary words
  assert.equal(redact("short"), "short");
});

test("record links: by agent id on mainnet, by wallet before an identity and on a sandbox fork", () => {
  assert.equal(recordLink({ agentId: 437, wallet: worker }), "https://priors.trade/agent?id=437");
  assert.equal(recordLink({ agentId: null, wallet: worker }), `https://priors.trade/agent?owner=${worker}`);
  assert.equal(recordLink({ agentId: 437, wallet: worker, sandbox: true }), `https://priors.trade/agent?owner=${worker}`);
});
