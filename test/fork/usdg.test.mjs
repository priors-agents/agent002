// (a) A buyer hires a worker for N minutes and pays N x rate USDG over x402, gets the result and the receipt, with no
// human action: on a local fork of Robinhood Chain, through agent002's CLI and examples/hire.mjs (@priors/x402's payer).
//
//   npm run test:fork      (needs anvil from Foundry)
// With AGENT002_MODEL set to an OpenRouter model and OPENROUTER_API_KEY in the environment, the job runs on that model
// instead of the stub; AGENT002_JOB_SPEND_CAP_USD bounds it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { startStack, say, fmt, printBalances, USDG, ERC20 } from "./stack.mjs";

const MODEL = process.env.AGENT002_MODEL || "stub";
const REAL = MODEL !== "stub";
const CAP = Number(process.env.AGENT002_JOB_SPEND_CAP_USD || 0.05);
let stack;

before(async () => {
  stack = await startStack({ name: "usdg", serveEnv: REAL ? { AGENT002_JOB_SPEND_CAP_USD: String(CAP) } : {} });
  say(stack.joined.trim());
  say(stack.ready.trim());
});
after(async () => { if (stack) await stack.stop(); });

test("(a) hire for N minutes, pay N x rate USDG over x402, get the result and a receipt", async () => {
  const N = 2;
  const task = REAL
    ? "Use your Priors tools: look up the record of Priors agent 437 and the pool's current figures, then write a 3-sentence summary of what you found."
    : "Say what Priors is in one sentence.";
  const m = (await stack.get("/manifest")).body;
  say(`\nGET /manifest -> ${m.name}: rate ${m.rate.perMinute.USDG} USDG / ${m.rate.perMinute.PRIORS} PRIORS per minute, ${m.minutes.min}-${m.minutes.max} minutes, payment ${m.payment.map((p) => `${p.token} (${p.method})`).join(", ")}, model ${m.model.name} (cap $${m.model.jobSpendCapUsd}/job, $${m.model.dailySpendCapUsd}/day)`);
  for (const w of m.workers) say(`  worker ${w.id}: agent #${w.agentId}, wallet ${w.wallet}, record ${w.record}, jobs done ${w.jobsDone}`);
  const price = BigInt(m.rate.perMinuteAtomic.USDG) * BigInt(N);

  // what an unpaid request gets: a 402 naming exactly N x rate, to the wallet of the worker it was assigned to
  const unpaid = await fetch(`${stack.url}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ minutes: N, task }) });
  assert.equal(unpaid.status, 402);
  const req = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")).accepts[0];
  say(`\nunpaid POST /jobs {minutes: ${N}} -> HTTP 402, PAYMENT-REQUIRED: scheme ${req.scheme}, network ${req.network}, asset ${req.asset} (USDG), amount ${req.amount} (${fmt(BigInt(req.amount), 6)} USDG = ${N} x ${m.rate.perMinute.USDG}), payTo ${req.payTo}, quote ${req.extra.quote}`);
  assert.equal(BigInt(req.amount), price);
  assert.ok(stack.workers.some((w) => w.address === req.payTo));

  const buyer = await stack.newBuyer({ usdg: 5 });
  const usdg = new ethers.Contract(USDG, ERC20, stack.provider);
  const before = await stack.balances();
  const buyerBefore = await usdg.balanceOf(buyer.address);
  say(`\nbuyer ${buyer.address} (an EOA) holds ${fmt(buyerBefore, 6)} USDG; it runs examples/hire.mjs --minutes ${N} --pay usdg`);

  const t0 = Date.now();
  const { job, settlementTx } = await stack.hire(buyer, { minutes: N, task });
  const took = (Date.now() - t0) / 1000;
  say(`settlement tx ${settlementTx}`);
  say(`job ${job.id}: ${job.status} on ${job.worker.id} (${job.worker.wallet}) in ${took.toFixed(1)} s`);
  say(`result: ${job.result}`);
  say(`receipt: ${JSON.stringify(job.receipt, null, 2)}`);

  assert.equal(job.status, "done");
  assert.ok(job.result && job.result.length > 0);
  const rc = job.receipt;
  assert.equal(rc.payer, buyer.address);
  assert.equal(rc.token, "USDG");
  assert.equal(rc.method, "x402");
  assert.equal(BigInt(rc.amountAtomic), price);
  assert.equal(rc.txHash, settlementTx);
  assert.equal(rc.minutesBought, N);
  assert.ok(rc.minutesUsed <= N, `used ${rc.minutesUsed} of ${N} minutes`);
  assert.ok(rc.startedAt && rc.finishedAt && Date.parse(rc.finishedAt) - Date.parse(rc.startedAt) <= N * 60_000);
  if (REAL) {
    assert.equal(rc.model, MODEL);
    assert.ok(rc.modelSpendUsd > 0 && rc.modelSpendUsd <= CAP, `model spend $${rc.modelSpendUsd}, cap $${CAP}`);
    say(`model ${rc.model}: ${rc.steps} steps, ${rc.toolCalls} tool calls, spent $${rc.modelSpendUsd} of a $${CAP} cap`);
  } else {
    assert.match(job.result, /stub answer \(deterministic, no language model\)/);
    assert.equal(rc.modelSpendUsd, 0.0002);
  }

  // on chain: the settlement moved exactly the price from the buyer to that worker's wallet
  const chainRc = await stack.provider.getTransactionReceipt(settlementTx);
  assert.equal(chainRc.status, 1);
  const moved = chainRc.logs.filter((l) => l.address.toLowerCase() === USDG.toLowerCase()).map((l) => usdg.interface.parseLog(l)).filter((e) => e?.name === "Transfer");
  assert.deepEqual(moved.map((e) => [e.args.from, e.args.to, e.args.value]), [[buyer.address, job.worker.wallet, price]]);
  say(`on chain: tx ${settlementTx} status 1, USDG Transfer ${buyer.address} -> ${job.worker.wallet} of ${fmt(price, 6)} USDG`);
  const afterB = await stack.balances();
  printBalances("worker balances before and after the job", before, afterB, stack.workers);
  for (const w of stack.workers) assert.equal(afterB[w.id].USDG - before[w.id].USDG, w.address === job.worker.wallet ? price : 0n);
  assert.equal(buyerBefore - (await usdg.balanceOf(buyer.address)), price);
  say(`buyer: ${fmt(buyerBefore, 6)} -> ${fmt(await usdg.balanceOf(buyer.address), 6)} USDG`);

  const m2 = (await stack.get("/manifest")).body;
  assert.equal(m2.workers.find((w) => w.id === job.worker.id).jobsDone, 1);
  say(`manifest after: ${m2.workers.map((w) => `${w.id} ${w.jobsDone} done`).join(", ")}`);
});

test("no key, private RPC URL or model key appears in anything any process printed", () => {
  const n = stack.checkNoSecrets();
  say(`\nscanned ${n} characters of output and log: no worker key, buyer-side secret, fork URL or model key`);
});
