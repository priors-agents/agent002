// The whole agent002 stack on a local fork of Robinhood Chain, through its CLI, as an operator runs it: init (three
// worker keys), sandbox (anvil + a fork-only facilitator), join (three ERC-8004 identities), serve. Buyers are fresh
// keys funded on the fork, hiring through examples/hire.mjs: @priors/x402's payer for USDG, an ERC-20 transfer for
// PRIORS. Everything any process prints is kept, so a test can check that no key ever appears in it.
//
// The fork reads Robinhood Chain from FORK_URL when set (a faster node), else from the public RPC. FORK_URL may hold
// a key: it is handed to the sandbox in its environment and never printed.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

export const BIN = fileURLToPath(new URL("../../bin/agent002.mjs", import.meta.url));
export const HIRE = fileURLToPath(new URL("../../examples/hire.mjs", import.meta.url));
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const PRIORS = "0xeDBf91223639800BCd5756815CAf908Df3b890bE";
export const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "event Transfer(address indexed from, address indexed to, uint256 value)"];
export const say = (...a) => console.log(...a);
export const fmt = (v, d) => ethers.formatUnits(v, d);

const waitFor = (child, re, ms, what) => new Promise((resolve, reject) => {
  let text = "";
  const t = setTimeout(() => reject(new Error(`${what} did not start in time: ${text.slice(-500)}`)), ms);
  const on = (d) => { text += d; if (re.test(text)) { clearTimeout(t); resolve(text); } };
  child.stdout.on("data", on);
  child.stderr.on("data", on);
  child.on("exit", (c) => { clearTimeout(t); reject(new Error(`${what} exited (${c}): ${text.slice(-500)}`)); });
});

export async function startStack({ name, serveEnv = {} }) {
  const dir = mkdtempSync(join(tmpdir(), `agent002-${name}-`));
  const port = 8700 + Math.floor(Math.random() * 600);
  const env = { ...process.env, AGENT002_HOME: join(dir, ".agent002") };
  delete env.AGENT002_RPC;
  delete env.FORK_URL;
  const transcript = [];
  const buyerKeys = [];
  const run = async (args, extraEnv = {}) => {
    try {
      const r = await promisify(execFile)(process.execPath, [BIN, ...args], { cwd: dir, env: { ...env, ...extraEnv }, timeout: 180_000 });
      transcript.push(r.stdout, r.stderr);
      return { code: 0, out: r.stdout + r.stderr };
    } catch (e) {
      transcript.push(e.stdout || "", e.stderr || "");
      return { code: e.code, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  const init = await run(["init"]);
  if (init.code !== 0) throw new Error(init.out);
  const sandboxEnv = { ...env, ...(process.env.FORK_URL ? { AGENT002_FORK_URL: process.env.FORK_URL } : {}) };
  const sandbox = spawn(process.execPath, [BIN, "sandbox", "--port", String(port)], { cwd: dir, env: sandboxEnv });
  transcript.push(await waitFor(sandbox, /sandbox ready[\s\S]*Ctrl-C/, 150_000, "the sandbox"));
  const rpc = `http://127.0.0.1:${port}`;
  const provider = new ethers.JsonRpcProvider(rpc, 4663, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 250;

  const joined = await run(["join"]);
  if (joined.code !== 0) throw new Error(joined.out);

  const servePort = port + 1000;
  const serve = spawn(process.execPath, [BIN, "serve", "--port", String(servePort)], { cwd: dir, env: { ...env, AGENT002_MODEL: process.env.AGENT002_MODEL || "stub", ...serveEnv } });
  let serveOut = "";
  serve.stdout.on("data", (d) => { serveOut += d; });
  serve.stderr.on("data", (d) => { serveOut += d; });
  const ready = await waitFor(serve, /Ctrl-C stops it/, 60_000, "the service");
  const url = `http://127.0.0.1:${servePort}`;
  const workers = JSON.parse(readFileSync(join(dir, ".agent002", "workers.json"), "utf8")).workers;

  const stack = {
    dir, rpc, url, provider, run, transcript, joined: joined.out, ready,
    workers: workers.map((w) => ({ id: w.id, address: w.address })),
    secrets: () => [...workers.map((w) => w.privateKey.slice(2).toLowerCase()), ...buyerKeys, ...(process.env.FORK_URL ? [process.env.FORK_URL.toLowerCase()] : []), ...(process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY.toLowerCase()] : [])],
    serveLog: () => serveOut,
    async get(path) { const r = await fetch(`${url}${path}`); return { status: r.status, headers: r.headers, body: await r.json() }; },
    async post(path, body) { const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, headers: r.headers, body: await r.json() }; },
    async newBuyer({ usdg = 5, priors = 500 } = {}) {
      const w = ethers.Wallet.createRandom();
      buyerKeys.push(w.privateKey.slice(2).toLowerCase());
      const f = await run(["fund", w.address, "--usdg", String(usdg), "--priors", String(priors)]);
      if (f.code !== 0) throw new Error(f.out);
      return w.connect(provider);
    },
    /** examples/hire.mjs as a buyer: { job, quote, settlementTx, payTx }. */
    async hire(buyer, { minutes, task, pay = "usdg" }) {
      try {
        const r = await promisify(execFile)(process.execPath, [HIRE, url, "--minutes", String(minutes), "--task", task, "--pay", pay, "--rpc", rpc, "--json"], { env: { ...process.env, BUYER_KEY: buyer.privateKey }, timeout: (minutes * 60 + 180) * 1000 });
        transcript.push(r.stdout, r.stderr);
        return JSON.parse(r.stdout.trim().split("\n").pop());
      } catch (e) {
        transcript.push(e.stdout || "", e.stderr || "");
        throw new Error(`hire failed: ${e.stderr || e.message}`);
      }
    },
    async balances() {
      const u = new ethers.Contract(USDG, ERC20, provider), p = new ethers.Contract(PRIORS, ERC20, provider);
      const out = {};
      for (const w of stack.workers) out[w.id] = { USDG: await u.balanceOf(w.address), PRIORS: await p.balanceOf(w.address) };
      return out;
    },
    async stop() {
      transcript.push(serveOut);
      serve.kill("SIGINT");
      sandbox.kill("SIGINT");
      await Promise.all([serve, sandbox].map((c) => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.on("exit", r)))));
      provider.destroy();
    },
    /** No worker key, private RPC URL or model key in anything any process printed, nor in the service's log. */
    checkNoSecrets() {
      const all = (transcript.join("\n") + serveOut + readFileSync(join(dir, ".agent002", "agent002.log"), "utf8")).toLowerCase();
      for (const s of stack.secrets()) if (all.includes(s)) throw new Error("a secret appears in the output");
      return all.length;
    },
  };
  return stack;
}

export function printBalances(title, before, after, workers) {
  say(`\n${title}`);
  say("worker  wallet                                       USDG before -> after (delta)              PRIORS before -> after (delta)");
  for (const w of workers) {
    const b = before[w.id], a = after[w.id];
    say(`${w.id.padEnd(7)} ${w.address}   ${fmt(b.USDG, 6)} -> ${fmt(a.USDG, 6)} (+${fmt(a.USDG - b.USDG, 6)})      ${fmt(b.PRIORS, 18)} -> ${fmt(a.PRIORS, 18)} (+${fmt(a.PRIORS - b.PRIORS, 18)})`);
  }
}

/** Wait until a PRIORS claim stops answering "not yet" (confirmations): the final answer. */
export async function claimUntilFinal(stack, body) {
  for (let i = 0; i < 60; i++) {
    const r = await stack.post("/jobs", body);
    if (!(r.status === 409 && r.body.retry)) return r;
    await new Promise((s) => setTimeout(s, 1000));
  }
  throw new Error("the claim never got a final answer");
}
