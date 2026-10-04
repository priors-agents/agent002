// (b) Paying in PRIORS, on a local fork of Robinhood Chain: a quote names the worker's wallet, the buyer transfers
// N x the PRIORS rate to it, the job is claimed with the transaction hash and runs. Then the same hash is refused (it
// paid once), a transfer one wei short is refused, and so are a transfer to another worker's wallet and a USDG transfer
// named as PRIORS.
//
//   npm run test:fork      (needs anvil from Foundry)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { startStack, say, fmt, printBalances, claimUntilFinal, PRIORS, USDG, ERC20 } from "./stack.mjs";

let stack;
before(async () => {
  stack = await startStack({ name: "priors" });
  say(stack.ready.trim());
});
after(async () => { if (stack) await stack.stop(); });

test("(b) PRIORS: quote, transfer, claim, run; then a reused hash and a short amount are refused", async () => {
  const p = new ethers.Contract(PRIORS, ERC20, stack.provider);
  assert.equal(await p.symbol(), "PRIORS");
  assert.equal(Number(await p.decimals()), 18);
  const m = (await stack.get("/manifest")).body;
  const pay = m.payment.find((x) => x.token === "PRIORS");
  say(`\nGET /manifest -> PRIORS ${pay.asset} (${pay.decimals} decimals), ${m.rate.perMinute.PRIORS} PRIORS a minute, paid by ${pay.method}, ${pay.confirmations} confirmations; ${pay.how}`);

  const buyer = await stack.newBuyer({ usdg: 2, priors: 500 });
  const N = 3;
  const before = await stack.balances();
  const { job, quote, payTx } = await stack.hire(buyer, { minutes: N, task: "Check Priors agent 437's record.", pay: "priors" });
  say(`\nPOST /quote {minutes: ${N}, payer: ${buyer.address}} -> quote ${quote.quote}: ${quote.amount} PRIORS to ${quote.worker.id} (${quote.payTo}), valid until ${quote.expiresAt}`);
  say(`the buyer transferred ${quote.amount} PRIORS: tx ${payTx}`);
  say(`POST /jobs {minutes, task, quote, payment: {token: "PRIORS", txHash}} -> job ${job.id}: ${job.status} on ${job.worker.id}`);
  say(`result: ${job.result}`);
  say(`receipt: ${JSON.stringify(job.receipt, null, 2)}`);
  const price = BigInt(m.rate.perMinuteAtomic.PRIORS) * BigInt(N);
  assert.equal(job.status, "done");
  assert.equal(BigInt(quote.amountAtomic), price);
  assert.deepEqual([job.receipt.token, job.receipt.method, job.receipt.txHash, job.receipt.payer, job.receipt.worker, BigInt(job.receipt.amountAtomic)], ["PRIORS", "transfer", payTx, buyer.address, quote.payTo, price]);
  assert.equal(job.worker.wallet, quote.payTo);
  const after1 = await stack.balances();
  printBalances("worker balances after the PRIORS job", before, after1, stack.workers);
  for (const w of stack.workers) assert.equal(after1[w.id].PRIORS - before[w.id].PRIORS, w.address === quote.payTo ? price : 0n);

  // the same transaction again, with a fresh quote: refused, it paid once
  const q2 = (await stack.post("/quote", { minutes: N, payer: buyer.address })).body;
  const reused = await stack.post("/jobs", { minutes: N, task: "again, for free?", quote: q2.quote, payment: { token: "PRIORS", txHash: payTx } });
  say(`\nREUSED HASH: POST /jobs with tx ${payTx} again (fresh quote ${q2.quote}) -> HTTP ${reused.status} ${JSON.stringify(reused.body)}`);
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "reused");

  // one wei short of the quote, to the right wallet
  const shortTx = await p.connect(buyer).transfer(q2.payTo, BigInt(q2.amountAtomic) - 1n);
  await shortTx.wait();
  const short = await claimUntilFinal(stack, { minutes: N, task: "short", quote: q2.quote, payment: { token: "PRIORS", txHash: shortTx.hash } });
  say(`SHORT AMOUNT: transferred ${fmt(BigInt(q2.amountAtomic) - 1n, 18)} PRIORS (price ${q2.amount}), tx ${shortTx.hash} -> HTTP ${short.status} ${JSON.stringify(short.body)}`);
  assert.equal(short.status, 402);
  assert.equal(short.body.code, "short_amount");

  // the full price, but to another worker's wallet than the quote's
  const elsewhere = stack.workers.find((w) => w.address !== q2.payTo).address;
  const wrongTo = await p.connect(buyer).transfer(elsewhere, BigInt(q2.amountAtomic));
  await wrongTo.wait();
  const wr = await claimUntilFinal(stack, { minutes: N, task: "wrong recipient", quote: q2.quote, payment: { token: "PRIORS", txHash: wrongTo.hash } });
  say(`WRONG RECIPIENT: paid ${q2.amount} PRIORS to ${elsewhere} instead of ${q2.payTo}, tx ${wrongTo.hash} -> HTTP ${wr.status} ${JSON.stringify(wr.body)}`);
  assert.equal(wr.status, 402);
  assert.equal(wr.body.code, "wrong_recipient");

  // a USDG transfer named as a PRIORS payment
  const u = new ethers.Contract(USDG, ERC20, buyer);
  const usdgTx = await u.transfer(q2.payTo, 1_000_000n);
  await usdgTx.wait();
  const wt = await claimUntilFinal(stack, { minutes: N, task: "wrong token", quote: q2.quote, payment: { token: "PRIORS", txHash: usdgTx.hash } });
  say(`WRONG TOKEN: a 1 USDG transfer to ${q2.payTo}, tx ${usdgTx.hash} -> HTTP ${wt.status} ${JSON.stringify(wt.body)}`);
  assert.equal(wt.status, 402);
  assert.equal(wt.body.code, "wrong_token");

  // none of the refusals started a job
  const m2 = (await stack.get("/manifest")).body;
  assert.equal(m2.workers.reduce((t, w) => t + w.jobsDone + w.jobsActive, 0), 1);
  say(`\nmanifest after: ${m2.workers.map((w) => `${w.id} ${w.jobsDone} done, earned ${w.earned.PRIORS} PRIORS`).join("; ")}`);
});

test("no key, private RPC URL or model key appears in anything any process printed", () => {
  const n = stack.checkNoSecrets();
  say(`\nscanned ${n} characters of output and log: no worker key, buyer key, fork URL or model key`);
});
