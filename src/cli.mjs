// The commands. Each takes its arguments (after the command name) and returns an exit code:
// 0 done, 1 failed, 2 usage, 3 waiting on something outside agent002 (funds, a registration).
import { existsSync, rmSync } from "node:fs";
import { ethers } from "ethers";
import { priorsFacilitatorClient } from "@priors/x402";
import { homeDir, ensureHome, pathOf, readJson, writeJson } from "./home.mjs";
import { createWorkers, loadWorkerFile, signerOf } from "./workers.mjs";
import { makeContext } from "./context.mjs";
import { PUBLIC_RPC, USDG, PRIORS, recordLink } from "./chain.mjs";
import { ERC20_ABI } from "./eth.mjs";
import { startFork, setUpSandbox, fund, serveFacilitator } from "./sandbox.mjs";
import { register, ownerOf, registrationUri } from "./join.mjs";
import { registerMerchant } from "./merchant.mjs";
import { localFacilitator } from "./facilitator-local.mjs";
import { makeDesk } from "./desk.mjs";
import { fileStore } from "./file-store.mjs";
import { localRunner } from "./runner.mjs";
import { listen } from "./server.mjs";
import { jsonRpc } from "./rpc.mjs";
import { makeModel } from "./model.mjs";
import { formatAtomic } from "./money.mjs";
import { addSecret } from "./secrets.mjs";

const out = (s) => process.stdout.write(s + "\n");
const usageError = (m) => Object.assign(new Error(m), { exitCode: 2 });

/** --name value / --flag parsing; positional arguments in `_`. */
export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2);
    if (flags.includes(k)) o[k] = true;
    else if (values.includes(k)) { if (i + 1 >= argv.length) throw usageError(`--${k} needs a value`); o[k] = argv[++i]; }
    else throw usageError(`unknown option ${a}`);
  }
  return o;
}

async function withContext(opts, fn) {
  const ctx = await makeContext(opts);
  try { return await fn(ctx); } finally { ctx.close(); }
}

const banner = (ctx) => (ctx.sandbox ? "[sandbox fork] " : "");

export const commands = {
  async init() {
    const home = ensureHome(homeDir());
    const { workers, path } = createWorkers(home);
    out("agent002's three workers, each with its own wallet:");
    for (const w of workers) out(`  ${w.id}  ${w.address}`);
    out(`Their keys are in ${path} (owner-only). Never share that file; agent002 never prints a key.`);
    out("");
    out("Next:");
    out("  try it on a local fork with play money:  agent002 sandbox   (in another terminal; needs Foundry's anvil)");
    out("  then:                                    agent002 join, then agent002 serve");
    out("  on mainnet: send each worker a little ETH on Robinhood Chain for gas, then agent002 join,");
    out("              agent002 merchant register --url https://<public URL>, and agent002 serve (or deploy the Worker)");
    return 0;
  },

  async sandbox(argv) {
    const a = parseArgs(argv, { values: ["port", "fork-url"] });
    const home = ensureHome(homeDir());
    const workers = loadWorkerFile(home);
    if (!workers.length) throw usageError("no workers yet: run `agent002 init` first");
    // a private node's URL is a secret: from --fork-url or AGENT002_FORK_URL, handed to anvil only, never printed
    const forkUrl = String(a["fork-url"] || process.env.AGENT002_FORK_URL || "").trim() || PUBLIC_RPC;
    if (forkUrl !== PUBLIC_RPC) addSecret(forkUrl);
    const fork = await startFork({ port: Number(a.port || 8545), forkUrl, log: (m) => out(m) });
    const stop = () => {
      fork.stop();
      const p = pathOf(home, "sandbox.json");
      const sb = readJson(p);
      if (sb) writeJson(p, { rpc: sb.rpc, stopped: true, stoppedAt: new Date().toISOString(), note: "this sandbox was stopped: start a new one with `agent002 sandbox`, or delete this file to use mainnet" });
    };
    process.on("SIGINT", () => { stop(); out(`\nsandbox stopped. Commands refuse to run until you start it again, or delete ${pathOf(home, "sandbox.json")} to use mainnet.`); process.exit(0); });
    process.on("SIGTERM", () => { stop(); process.exit(0); });
    try {
      rmSync(pathOf(home, "sandbox-state.json"), { force: true }); // a new fork: no jobs or used transactions from the last one
      const s = await setUpSandbox(fork.provider, { home, rpc: fork.rpc, workers });
      const facPort = Number(a.port || 8545) + 2;
      await serveFacilitator(localFacilitator(new ethers.Wallet(readJson(pathOf(home, "sandbox.json")).facilitatorKey, fork.provider)), facPort);
      out(`sandbox ready on ${fork.rpc}: a fork of Robinhood Chain at block ${await fork.provider.getBlockNumber()}, a block every second.`);
      for (const w of workers) out(`  worker ${w.id} ${w.address} got 1 ETH for gas (play money, on this fork only)`);
      out(`a fork-only facilitator (${s.facilitator}) settles x402 payments on the fork: in process for agent002 serve, and on http://127.0.0.1:${facPort} for a Worker under wrangler dev (AGENT002_FACILITATOR_URL).`);
      out("Next: agent002 join · agent002 serve · agent002 fund <buyer address> for play USDG and PRIORS. Ctrl-C stops it.");
    } catch (e) { stop(); throw e; }
    await new Promise(() => {}); // keep anvil alive until Ctrl-C
  },

  async fund(argv) {
    const a = parseArgs(argv, { values: ["usdg", "priors", "eth"] });
    const address = a._[0];
    if (!address || !ethers.isAddress(address)) throw usageError("usage: agent002 fund <address> [--usdg 20] [--priors 1000] [--eth 1]   (sandbox only)");
    return withContext({}, async (ctx) => {
      if (!ctx.sandbox) throw usageError("fund only works in the sandbox (on mainnet, send real tokens yourself)");
      const amounts = { usdg: Number(a.usdg ?? 20), priors: Number(a.priors ?? 1000), eth: Number(a.eth ?? 1) };
      await fund(ctx.provider, ethers.getAddress(address), amounts);
      out(`${banner(ctx)}${ethers.getAddress(address)} has ${amounts.eth} ETH, ${amounts.usdg} USDG and ${amounts.priors} PRIORS of play money.`);
      return 0;
    });
  },

  async join(argv) {
    const a = parseArgs(argv, { values: ["url"] });
    return withContext({}, async (ctx) => {
      const workers = ctx.settings.workers;
      if (!workers.length) throw usageError("no workers yet: run `agent002 init` first");
      const todo = [];
      for (const w of workers) {
        if (w.agentId !== null) {
          let owner = null;
          try { owner = await ownerOf(ctx.provider, w.agentId); } catch (_) { /* no such id */ }
          if (owner && owner === w.address) { out(`${banner(ctx)}worker ${w.id} is already agent #${w.agentId} (owned by ${w.address}).`); continue; }
          out(`${banner(ctx)}worker ${w.id}: agent #${w.agentId} is not owned by ${w.address} here; registering a new identity.`);
        }
        todo.push(w);
      }
      const broke = [];
      for (const w of todo) if ((await ctx.provider.getBalance(w.address)) === 0n) broke.push(w);
      if (broke.length) {
        out(`these workers need a little ETH on Robinhood Chain for the registration's gas (0.0005 ETH is plenty):`);
        for (const w of broke) out(`  ${w.id}  ${w.address}`);
        return 3;
      }
      for (const w of todo) {
        const r = await register(signerOf(w, ctx.provider), registrationUri(w, a.url || ctx.settings.publicUrl));
        ctx.saveAgentId(w.id, r.agentId);
        out(`${banner(ctx)}worker ${w.id} registered as agent #${r.agentId} (ERC-8004, owned by ${w.address}), tx ${r.hash}`);
      }
      for (const w of workers) out(`  ${w.id}  agent #${w.agentId}  ${recordLink({ agentId: w.agentId, wallet: w.address, sandbox: ctx.sandbox })}`);
      if (!ctx.sandbox && todo.length) out("Set AGENT002_WORKER_AGENT_ID_<n> to these ids where the service runs (wrangler.jsonc vars for the Worker).");
      return 0;
    });
  },

  async serve(argv) {
    const a = parseArgs(argv, { values: ["port", "host"] });
    const ctx = await makeContext({});
    const { settings } = ctx;
    if (!settings.workers.length) { ctx.close(); throw usageError("no workers: run `agent002 init`, or set AGENT002_WORKER_ADDRESS_1..3"); }
    let facilitatorFor, how;
    if (ctx.sandbox) {
      if (!ctx.sandboxFile?.facilitatorKey) { ctx.close(); throw new Error("this sandbox has no facilitator key: start it with `agent002 sandbox` from this folder"); }
      const local = localFacilitator(new ethers.Wallet(ctx.sandboxFile.facilitatorKey, ctx.provider));
      facilitatorFor = () => local;
      how = "the sandbox's local facilitator";
      // the fork mines a block a second: a few confirmations, unless set
      if (!process.env.AGENT002_PRIORS_CONFIRMATIONS) settings.priorsConfirmations = 3;
    } else {
      const merchant = readJson(pathOf(ctx.home, "merchant.json"), {}) || {};
      const clients = new Map();
      const missing = [];
      for (const w of settings.workers) {
        const m = merchant.workers?.[w.id];
        const apiKey = settings.facilitatorKeys[w.id] || (m && m.payTo?.toLowerCase() === w.address.toLowerCase() ? m.apiKey : null);
        if (!apiKey) { missing.push(w); continue; }
        addSecret(apiKey);
        clients.set(w.id, priorsFacilitatorClient({ url: settings.facilitatorUrl, apiKey }));
      }
      if (missing.length) { ctx.close(); throw Object.assign(new Error(`no facilitator API key for ${missing.map((w) => w.id).join(", ")}: run \`agent002 merchant register --url https://<public URL>\` (or set AGENT002_FACILITATOR_KEY_<n>)`), { exitCode: 3 }); }
      facilitatorFor = (w) => clients.get(w.id);
      how = `the Priors facilitator (${settings.facilitatorUrl})`;
    }
    try { await makeModel(settings); } catch (e) { ctx.close(); throw e; } // a missing key or an unpriced model fails now, not after a payment
    const store = fileStore(pathOf(ctx.home, ctx.sandbox ? "sandbox-state.json" : "state.json"));
    const desk = makeDesk({ settings, store, runner: localRunner({ settings, log: ctx.log }), facilitatorFor, rpc: jsonRpc(ctx.rpc), sandbox: ctx.sandbox, log: ctx.log });
    await desk.recover();
    const host = a.host || "127.0.0.1";
    const server = await listen(desk.handle, { port: Number(a.port || process.env.PORT || 4022), host, log: ctx.log });
    const port = server.address().port;
    out(`${banner(ctx)}agent002 on http://${host}:${port}: ${settings.workers.length} workers (${settings.workers.map((w) => `${w.id} ${w.address}${w.agentId !== null ? ` #${w.agentId}` : ""}`).join(", ")})`);
    out(`  ${formatAtomic(settings.rateUsdgAtomic, USDG.decimals)} USDG or ${formatAtomic(settings.ratePriorsAtomic, PRIORS.decimals)} PRIORS a minute, ${settings.minMinutes} to ${settings.maxMinutes} minutes; x402 settled by ${how}; PRIORS needs ${settings.priorsConfirmations} confirmations`);
    out(`  model ${settings.model}: at most $${settings.jobSpendCapUsd} a job and $${settings.dailySpendCapUsd} a UTC day. GET /manifest. Ctrl-C stops it.`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
    server.close();
    ctx.close();
    return 0;
  },

  async status() {
    return withContext({}, async (ctx) => {
      const { settings } = ctx;
      if (!settings.workers.length) { out("no workers yet: run `agent002 init`"); return 0; }
      const usdg = new ethers.Contract(USDG.address, ERC20_ABI, ctx.provider);
      const priors = new ethers.Contract(PRIORS.address, ERC20_ABI, ctx.provider);
      const fleet = readJson(pathOf(ctx.home, ctx.sandbox ? "sandbox-state.json" : "state.json"), {})?.fleet || { workers: {} };
      for (const w of settings.workers) {
        const [u, p, e] = await Promise.all([usdg.balanceOf(w.address), priors.balanceOf(w.address), ctx.provider.getBalance(w.address)]);
        const c = fleet.workers?.[w.id] || {};
        out(`${banner(ctx)}${w.id} ${w.address}: ${formatAtomic(u, 6)} USDG, ${formatAtomic(p, 18)} PRIORS, ${ethers.formatEther(e)} ETH; ${w.agentId !== null ? `agent #${w.agentId}` : "no identity yet (agent002 join)"}; ${c.done || 0} jobs done${c.active ? `, ${c.active} queued or running` : ""}`);
        out(`    ${recordLink({ agentId: w.agentId, wallet: w.address, sandbox: ctx.sandbox })}`);
      }
      return 0;
    });
  },

  async merchant(argv) {
    const a = parseArgs(argv, { values: ["url"] });
    if (a._[0] !== "register" || !a.url) throw usageError("usage: agent002 merchant register --url https://<public URL of the service>");
    return withContext({}, async (ctx) => {
      if (ctx.sandbox) throw usageError("in the sandbox, `agent002 serve` settles with a local facilitator: no registration needed");
      const path = pathOf(ctx.home, "merchant.json");
      const saved = readJson(path, {}) || {};
      const workers = { ...(saved.workers || {}) };
      for (const w of ctx.settings.workers) {
        const r = await registerMerchant({ signer: signerOf(w, ctx.provider), url: a.url, name: `agent002 ${w.id}`, description: "Hire this agent002 worker by the minute: POST /jobs, paid in USDG over x402 or in PRIORS.", facilitator: ctx.settings.facilitatorUrl });
        workers[w.id] = { payTo: r.payTo, apiKey: r.apiKey, url: a.url, facilitator: ctx.settings.facilitatorUrl, registeredAt: new Date().toISOString() };
        writeJson(path, { ...saved, workers });
        out(`registered worker ${w.id} (${r.payTo}) with the Priors facilitator${r.rotated ? " (its previous key is revoked)" : ""}.`);
      }
      out(`The API keys are in ${path}; agent002 serve uses them. For the Worker: agent002 wrangler-secrets.`);
      return 0;
    });
  },

  async "wrangler-secrets"() {
    const home = ensureHome(homeDir());
    const merchant = readJson(pathOf(home, "merchant.json"), {}) || {};
    const fleet = readJson(pathOf(home, "fleet.json"), {}) || {};
    const workers = loadWorkerFile(home);
    if (!workers.length) throw usageError("no workers yet: run `agent002 init` first");
    const secrets = {};
    for (const w of workers) {
      const m = merchant.workers?.[w.id];
      if (m?.apiKey && m.payTo?.toLowerCase() === w.address.toLowerCase()) secrets[`AGENT002_FACILITATOR_KEY_${w.n}`] = m.apiKey;
    }
    if (process.env.OPENROUTER_API_KEY) secrets.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const path = pathOf(home, "wrangler-secrets.json");
    writeJson(path, secrets);
    out(`wrote ${Object.keys(secrets).length} secret(s) to ${path} (owner-only): ${Object.keys(secrets).join(", ") || "none"}`);
    out(`  npx wrangler secret bulk ${path}   then delete the file`);
    if (!secrets.OPENROUTER_API_KEY) out("  npx wrangler secret put OPENROUTER_API_KEY   (it was not in this shell's environment)");
    out("Public settings for wrangler.jsonc's \"vars\" (addresses and ids, no secret):");
    const vars = {};
    for (const w of workers) {
      vars[`AGENT002_WORKER_ADDRESS_${w.n}`] = w.address;
      if (fleet.agentIds?.[w.id] !== undefined) vars[`AGENT002_WORKER_AGENT_ID_${w.n}`] = String(fleet.agentIds[w.id]);
    }
    out(JSON.stringify(vars, null, 2));
    return 0;
  },
};

export function usage() {
  return `agent002: three worker agents that sell their time by the minute on Robinhood Chain

  agent002 init                          make the three workers' wallets (keys kept in .agent002/, never printed)
  agent002 sandbox [--port 8545]         run a local fork with play money (needs anvil); commands use it while it runs
                                         (the fork's source: --fork-url or AGENT002_FORK_URL, default the public RPC)
  agent002 fund <address> [--usdg 20] [--priors 1000] [--eth 1]   sandbox only: play money for a buyer
  agent002 join [--url https://...]      register the workers' ERC-8004 identities (one transaction each)
  agent002 serve [--port 4022]           sell the workers' time (sandbox: local facilitator; mainnet: merchant keys)
  agent002 status                        each worker's wallet, balances, identity and jobs done
  agent002 merchant register --url U     register each worker with the Priors facilitator (one signature each, no gas)
  agent002 wrangler-secrets              write the Worker's secrets for \`wrangler secret bulk\`, print its vars
`;
}
