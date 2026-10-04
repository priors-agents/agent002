// (c) The fleet, on a local fork of Robinhood Chain: `agent002 join` registers three ERC-8004 identities (one per
// worker wallet), jobs paid in USDG and in PRIORS spread over all three workers through one queue, and each worker's
// wallet rises by exactly the prices of its own jobs.
//
//   npm run test:fork      (needs anvil from Foundry)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { startStack, say, fmt, printBalances } from "./stack.mjs";

let stack;
before(async () => {
  stack = await startStack({ name: "fleet" });
  say(stack.joined.trim());
  say(stack.ready.trim());
});
after(async () => { if (stack) await stack.stop(); });

test("join: each worker wallet owns its own ERC-8004 identity on chain, and the manifest names it", async () => {
  const m = (await stack.get("/manifest")).body;
  const reg = new ethers.Contract("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", ["function ownerOf(uint256) view returns (address)", "function tokenURI(uint256) view returns (string)"], stack.provider);
  const ids = new Set();
  for (const w of m.workers) {
    assert.ok(Number.isInteger(w.agentId), `${w.id} has an agent id`);
    ids.add(w.agentId);
    const owner = await reg.ownerOf(w.agentId);
    const uri = await reg.tokenURI(w.agentId);
    const file = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    say(`worker ${w.id}: agent #${w.agentId} ownerOf -> ${owner} (its wallet ${w.wallet}); registration "${file.name}", services ${file.services.map((s) => `${s.name}=${s.endpoint}`).join(", ")}`);
    assert.equal(owner, w.wallet);
    assert.equal(file.name, `agent002 ${w.id}`);
  }
  assert.equal(ids.size, 3);
  // join again: nothing new
  const again = await stack.run(["join"]);
  assert.equal(again.code, 0);
  assert.equal((again.out.match(/is already agent #\d+/g) || []).length, 3);
});

test("(c) jobs spread over all three workers; each wallet rises by exactly its jobs' prices", async () => {
  const m = (await stack.get("/manifest")).body;
  const rate = { USDG: BigInt(m.rate.perMinuteAtomic.USDG), PRIORS: BigInt(m.rate.perMinuteAtomic.PRIORS) };
  const buyers = [await stack.newBuyer({ usdg: 5, priors: 500 }), await stack.newBuyer({ usdg: 5, priors: 500 })];
  const before = await stack.balances();
  printBalances("worker balances before", before, before, stack.workers);

  // two pairs of USDG jobs at the same time (two buyers), then two PRIORS jobs
  const plan = [
    [{ minutes: 1, pay: "usdg" }, { minutes: 2, pay: "usdg" }],
    [{ minutes: 3, pay: "usdg" }, { minutes: 1, pay: "usdg" }],
    [{ minutes: 2, pay: "priors" }],
    [{ minutes: 1, pay: "priors" }],
  ];
  const jobs = [];
  let n = 0;
  for (const batch of plan) {
    const results = await Promise.all(batch.map((j, i) => stack.hire(buyers[i], { minutes: j.minutes, task: `fleet job ${++n}: ${j.minutes} minute(s) paid in ${j.pay}`, pay: j.pay })));
    for (const r of results) {
      jobs.push(r.job);
      say(`job ${r.job.id}: ${r.job.minutes} min, ${r.job.receipt.amount} ${r.job.receipt.token} from ${r.job.receipt.payer} to ${r.job.worker.id} (${r.job.worker.wallet}), tx ${r.job.receipt.txHash}, ${r.job.status}`);
    }
  }
  assert.equal(jobs.length, 6);
  for (const j of jobs) assert.equal(j.status, "done");

  const after = await stack.balances();
  printBalances("worker balances after", before, after, stack.workers);
  const expected = Object.fromEntries(stack.workers.map((w) => [w.id, { USDG: 0n, PRIORS: 0n, jobs: 0 }]));
  for (const j of jobs) {
    const price = rate[j.receipt.token] * BigInt(j.minutes);
    assert.equal(BigInt(j.receipt.amountAtomic), price, `${j.id} paid minutes x rate`);
    expected[j.worker.id][j.receipt.token] += price;
    expected[j.worker.id].jobs++;
  }
  say("\nworker  jobs  expected USDG  actual USDG delta  expected PRIORS  actual PRIORS delta");
  for (const w of stack.workers) {
    const e = expected[w.id];
    const dU = after[w.id].USDG - before[w.id].USDG, dP = after[w.id].PRIORS - before[w.id].PRIORS;
    say(`${w.id.padEnd(7)} ${String(e.jobs).padEnd(5)} ${fmt(e.USDG, 6).padEnd(14)} ${fmt(dU, 6).padEnd(18)} ${fmt(e.PRIORS, 18).padEnd(16)} ${fmt(dP, 18)}`);
    assert.ok(e.jobs >= 1, `${w.id} took at least one job`);
    assert.equal(dU, e.USDG, `${w.id}'s USDG rose by exactly its jobs' prices`);
    assert.equal(dP, e.PRIORS, `${w.id}'s PRIORS rose by exactly its jobs' prices`);
  }
  const m2 = (await stack.get("/manifest")).body;
  for (const w of m2.workers) assert.equal(w.jobsDone, expected[w.id].jobs);
  say(`\nmanifest after: ${m2.workers.map((w) => `${w.id}: ${w.jobsDone} jobs done, earned ${w.earned.USDG} USDG + ${w.earned.PRIORS} PRIORS`).join("; ")}`);
});

test("no key, private RPC URL or model key appears in anything any process printed", () => {
  const n = stack.checkNoSecrets();
  say(`\nscanned ${n} characters of output and log: no worker key, buyer key, fork URL or model key`);
});
