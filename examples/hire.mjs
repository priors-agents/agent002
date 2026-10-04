#!/usr/bin/env node
// Hire an agent002 worker, as a buyer, with no human in the loop: read the manifest, pay, wait for the result, print
// the receipt.
//
//   BUYER_KEY=0x... node examples/hire.mjs <agent002 URL> --minutes 2 --task "..." [--pay usdg|priors] [--rpc URL] [--json]
//
// --pay usdg (default): x402 v2 with @priors/x402's payer. POST /jobs answers 402 for minutes x rate USDG to the
//   assigned worker's wallet; the payer signs an EIP-3009 authorization for exactly that (never more than the
//   manifest's rate x minutes) and sends the same request again; the facilitator settles it.
// --pay priors: POST /quote names the worker's wallet and the amount; this script transfers that much PRIORS from
//   the buyer's wallet, then claims the job with the transaction hash (retrying while confirmations gather).
//
// The buyer's key comes from BUYER_KEY in the environment, never from an argument, and is never printed. The buyer
// pays from an EOA (a plain key): the facilitator settles only EOA payers, and a PRIORS quote binds the payer's address.
// --rpc: Robinhood Chain's JSON-RPC (default the public one; the sandbox's http://127.0.0.1:8545 on a fork).
import { ethers } from "ethers";
import { createPayer, formatUsdg } from "@priors/x402";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const PRIORS = "0xeDBf91223639800BCd5756815CAf908Df3b890bE";

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

const a = args(process.argv.slice(2));
const base = String(a._[0] || "").replace(/\/+$/, "");
const minutes = Number(a.minutes);
const task = a.task;
const pay = (a.pay || "usdg").toLowerCase();
if (!/^https?:\/\//.test(base) || !Number.isInteger(minutes) || minutes < 1 || !task || !["usdg", "priors"].includes(pay)) {
  process.stderr.write("usage: BUYER_KEY=0x... node examples/hire.mjs <agent002 URL> --minutes N --task \"...\" [--pay usdg|priors] [--rpc URL] [--json]\n");
  process.exit(2);
}
const key = String(process.env.BUYER_KEY || "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) { process.stderr.write("set BUYER_KEY (the buyer's private key) in the environment\n"); process.exit(2); }

const provider = new ethers.JsonRpcProvider(a.rpc || PUBLIC_RPC, 4663, { staticNetwork: true });
const buyer = new ethers.Wallet(key, provider);
const say = (s) => { if (!a.json) process.stdout.write(s + "\n"); };
const getJson = async (path, init) => { const r = await fetch(`${base}${path}`, init); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };

const manifest = (await getJson("/manifest")).body;
if (!manifest?.rate) throw new Error(`no agent002 manifest at ${base}/manifest`);
say(`${manifest.name}: ${manifest.workers.length} workers, ${manifest.rate.perMinute.USDG} USDG or ${manifest.rate.perMinute.PRIORS} PRIORS a minute`);

let created, settlementTx = null, payTx = null, quote = null;
const body = JSON.stringify({ minutes, task });

if (pay === "usdg") {
  // the most this payer will sign: the manifest's rate x minutes, so a 402 asking more is refused unsigned
  const maxPrice = BigInt(manifest.rate.perMinuteAtomic.USDG) * BigInt(minutes);
  const payer = createPayer({ signer: buyer, maxPrice, timeoutMs: 120_000 });
  const r = await payer.pay(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body });
  created = await r.response.json().catch(() => null);
  if (r.response.status !== 201 && r.response.status !== 200) throw new Error(`hiring failed: HTTP ${r.response.status} ${JSON.stringify(created)}`);
  settlementTx = r.settlement?.transaction || created?.receipt?.txHash || null;
  say(`paid ${formatUsdg(r.paid)} USDG over x402 to ${created.worker.id} (${created.worker.wallet}); settlement tx ${settlementTx}`);
} else {
  const q = await getJson("/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ minutes, payer: buyer.address }) });
  if (q.status !== 200) throw new Error(`no quote: HTTP ${q.status} ${JSON.stringify(q.body)}`);
  quote = q.body;
  say(`quote ${quote.quote}: ${quote.amount} PRIORS to ${quote.worker.id} (${quote.payTo}), ${quote.confirmations} confirmations`);
  const token = new ethers.Contract(PRIORS, ["function transfer(address,uint256) returns (bool)"], buyer);
  const tx = await token.transfer(quote.payTo, BigInt(quote.amountAtomic));
  await tx.wait();
  payTx = tx.hash;
  say(`transferred ${quote.amount} PRIORS, tx ${payTx}`);
  const claim = JSON.stringify({ minutes, task, quote: quote.quote, payment: { token: "PRIORS", txHash: payTx } });
  for (let i = 0; ; i++) {
    const r = await getJson("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: claim });
    if (r.status === 201) { created = r.body; break; }
    if (!r.body?.retry || i > 60) throw new Error(`the claim was refused: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    say(`not yet: ${r.body.error}`);
    await new Promise((s) => setTimeout(s, 2000));
  }
  settlementTx = payTx;
}

say(`job ${created.id} ${created.status} on ${created.worker.id}; waiting for the result...`);
let job;
for (const until = Date.now() + (minutes * 60 + 90) * 1000; ;) {
  job = (await getJson(`/jobs/${created.id}`)).body;
  if (job.status === "done" || job.status === "failed") break;
  if (Date.now() > until) throw new Error(`job ${created.id} did not finish in time`);
  await new Promise((s) => setTimeout(s, 1000));
}
if (a.json) process.stdout.write(JSON.stringify({ job, quote, settlementTx, payTx }) + "\n");
else {
  say(`\n${job.status}: ${job.result ?? job.error}\n`);
  say(`receipt: ${JSON.stringify(job.receipt, null, 2)}`);
}
provider.destroy();
