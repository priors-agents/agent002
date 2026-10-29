// agent002's settings, from the environment: the same variables in Node (a shell, Docker) and in a Cloudflare Worker
// (wrangler.jsonc `vars` and secrets). Secrets (the OpenRouter key, worker keys, facilitator API keys) are read here
// and registered for redaction; they are never part of anything this module returns to print.
//
//   AGENT002_RATE_USDG             USDG per minute (default 0.10)
//   AGENT002_RATE_PRIORS           PRIORS per minute (default 25)
//   AGENT002_MIN_MINUTES, _MAX_MINUTES   a job's length, whole minutes (1 to 10)
//   AGENT002_MODEL                 an OpenRouter model id (default openai/gpt-6-luna), or "stub" for tests
//   AGENT002_MODEL_PRICE           optional: "in,out" USD per million tokens, instead of OpenRouter's list
//   AGENT002_JOB_SPEND_CAP_USD     most one job may spend on the model (default 0.05)
//   AGENT002_DAILY_SPEND_CAP_USD   most all jobs together may spend on the model in a UTC day (default 3)
//   AGENT002_PRIORS_CONFIRMATIONS  blocks a PRIORS payment needs (default 20, about 2 s on Robinhood Chain)
//   AGENT002_PRIORS_QUOTE_SECONDS  how long after its quote a PRIORS transfer counts (default 1800)
//   AGENT002_WORKER_CONCURRENCY    jobs one worker runs at a time (default 1)
//   AGENT002_OPENROUTER_URL        the model endpoint (default https://openrouter.ai/api/v1)
//   AGENT002_RPC                   Robinhood Chain JSON-RPC (default the public one)
//   AGENT002_FACILITATOR_URL       the x402 facilitator (default https://facilitator.priors.trade)
//   AGENT002_PUBLIC_URL            the service's public URL (default: the URL each request came to)
//   AGENT002_VERSION               the source commit a deployment runs, shown in the manifest (default none)
//   AGENT002_WORKER_ADDRESS_<n>    worker n's wallet (n = 1, 2, 3); or
//   AGENT002_WORKER_KEY_<n>        worker n's key, secret (the address is derived from it)
//   AGENT002_WORKER_AGENT_ID_<n>   worker n's ERC-8004 agent id, once `agent002 join` registered it
//   AGENT002_FACILITATOR_KEY_<n>   secret: worker n's API key with the Priors facilitator (`agent002 merchant register`)
//   AGENT002_HIRE_WORKERS          hire-only workers: "agentId:wallet,agentId:wallet,..." (each wallet the agent's ERC-8004
//                                  registry wallet, where its jobs are paid). Continued in AGENT002_HIRE_WORKERS_2, _3...
//                                  (a hosting platform's variable holds a few KB). A hire-only worker takes only the jobs
//                                  that name it (POST /jobs {agentId, ...}); jobs that name none go to the workers above
//   AGENT002_HIRE_FACILITATOR_KEY  secret: the Priors facilitator API key that settles for the hire-only workers
//   AGENT002_INTERNAL_PAYERS       the operator's own payer wallets: "0x...,0x...", continued in AGENT002_INTERNAL_PAYERS_2,
//                                  _3... A job one of them pays is quoted, paid, settled and run as any other; the manifest's
//                                  public counters (a worker's jobsDone, jobsActive, earned) leave it out, so the operator's
//                                  own use never reads as demand. Set it in the deployment's variables; nothing answers it
//   AGENT002_STOCK_DESKS           the agents that sell a Stock Token research brief per call (src/stock-desk.mjs), each
//                                  paid at its own wallet: "agentId" for one of the workers above (numbered or hire-only),
//                                  or "agentId:wallet" for a desk-only worker (its registry wallet), one that sells briefs
//                                  and no minutes; comma-separated. Their briefs come from the brief source (a Worker's
//                                  STOCK_BRIEFS binding); desk-only workers settle with AGENT002_HIRE_FACILITATOR_KEY
//   AGENT002_DESK_PRICE_USDG       the brief's price, USDG a call (default 0.05; at most 0.10)
//   AGENT002_DESK_JOB_CAP_USD      most one brief may spend on the model (default 0.02; at most half the price, and at most
//                                  AGENT002_JOB_SPEND_CAP_USD)
//   AGENT002_DESK_DAILY_CAP_USD    most one desk agent's jobs may spend on the model in a UTC day, its own budget, shared
//                                  with no other agent (default 0.50): every job it runs, briefs and minutes alike
//   AGENT002_DESK_MAX_STEPS        model calls one brief may make at most (default 2, from 1 to 12)
//   OPENROUTER_API_KEY             secret: the model provider's key
import { computeAddress, getAddress } from "ethers";
import { PUBLIC_RPC, USDG, PRIORS, isAddress } from "./chain.mjs";
import { toAtomic } from "./money.mjs";
import { DEFAULT_MODEL, OPENROUTER, parsePriceOverride } from "./model.mjs";
import { addSecret } from "./secrets.mjs";

export const FACILITATOR = "https://facilitator.priors.trade";
export const MAX_WORKERS = 9;
/** AGENT002_HIRE_WORKERS, then AGENT002_HIRE_WORKERS_2 up to this: how many variables the hire-only list may span. */
export const MAX_HIRE_VARS = 20;

export const DEFAULTS = Object.freeze({
  rateUsdg: "0.10",
  ratePriors: "25",
  minMinutes: 1,
  maxMinutes: 10,
  model: DEFAULT_MODEL,
  jobSpendCapUsd: 0.05,
  dailySpendCapUsd: 3,
  priorsConfirmations: 20,
  x402QuoteSeconds: 300, //    how long an x402 payment authorization may stay valid (the 402's maxTimeoutSeconds)
  priorsQuoteSeconds: 1800, // a PRIORS transfer must be mined within 30 minutes of its quote
  claimWindowHours: 48, //     and claimed within 48 hours (a valid payment refused for the daily cap stays claimable)
  workerConcurrency: 1, //     jobs one worker runs at a time
  rpc: PUBLIC_RPC,
  facilitatorUrl: FACILITATOR,
  publicUrl: null,
});

const num = (env, name, dflt, { integer = false, min = 0, gt = false } = {}) => {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const v = Number(String(raw).trim());
  if (!Number.isFinite(v) || (integer && !Number.isInteger(v)) || (gt ? v <= min : v < min)) throw new Error(`${name} must be ${integer ? "a whole number" : "a number"} ${gt ? "above" : "of at least"} ${min} (got ${JSON.stringify(raw)})`);
  return v;
};
/** A node on this machine (the sandbox fork): its URL is not a secret. */
export const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(String(url));
const str = (env, name, dflt) => (env[name] !== undefined && String(env[name]).trim() !== "" ? String(env[name]).trim() : dflt);

/**
 * The workers named by the environment: AGENT002_WORKER_KEY_<n> or AGENT002_WORKER_ADDRESS_<n>, n = 1..9.
 * Keys are registered as secrets; what is returned holds the key only under `key`, for the commands that sign.
 */
export function workersFromEnv(env) {
  const out = [];
  for (let n = 1; n <= MAX_WORKERS; n++) {
    const key = str(env, `AGENT002_WORKER_KEY_${n}`, null);
    let address = str(env, `AGENT002_WORKER_ADDRESS_${n}`, null);
    if (!key && !address) continue;
    if (key) {
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error(`AGENT002_WORKER_KEY_${n} is not a private key (64 hex digits)`);
      addSecret(key);
      const derived = computeAddress(key.startsWith("0x") ? key : `0x${key}`);
      if (address && address.toLowerCase() !== derived.toLowerCase()) throw new Error(`AGENT002_WORKER_ADDRESS_${n} is not the address of AGENT002_WORKER_KEY_${n}`);
      address = derived;
    }
    if (!isAddress(address)) throw new Error(`AGENT002_WORKER_ADDRESS_${n} is not an address`);
    const id = str(env, `AGENT002_WORKER_AGENT_ID_${n}`, null);
    if (id !== null && !/^\d{1,12}$/.test(id)) throw new Error(`AGENT002_WORKER_AGENT_ID_${n} must be an agent id (digits)`);
    out.push({ id: `w${n}`, n, address: getAddress(address), agentId: id === null ? null : Number(id), ...(key ? { key: key.startsWith("0x") ? key : `0x${key}` } : {}) });
  }
  return out;
}

/**
 * The hire-only workers: AGENT002_HIRE_WORKERS, then _2, _3... ("agentId:wallet" items, comma-separated), each
 * { id: "a<agentId>", n: null, agentId, address, hireOnly: true }. Ids and wallets are public; nothing here is secret.
 */
export function hireWorkersFromEnv(env) {
  const out = [];
  for (let k = 1; k <= MAX_HIRE_VARS; k++) {
    const name = k === 1 ? "AGENT002_HIRE_WORKERS" : `AGENT002_HIRE_WORKERS_${k}`;
    const raw = str(env, name, null);
    if (raw === null) continue;
    for (const item of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\d{1,12}):(0x[0-9a-fA-F]{40})$/.exec(item);
      if (!m) throw new Error(`${name}: ${JSON.stringify(item.slice(0, 60))} is not agentId:wallet`);
      out.push({ id: `a${Number(m[1])}`, n: null, agentId: Number(m[1]), address: getAddress(m[2]), hireOnly: true });
    }
  }
  return out;
}

/** AGENT002_INTERNAL_PAYERS, then _2 up to this: how many variables the internal payers may span. */
export const MAX_INTERNAL_VARS = 20;

/** The internal payers: AGENT002_INTERNAL_PAYERS, then _2, _3... (addresses, comma-separated), as a Set of lower-case
 *  addresses. Nothing the service answers names them. */
export function internalPayersFromEnv(env) {
  const out = new Set();
  for (let k = 1; k <= MAX_INTERNAL_VARS; k++) {
    const name = k === 1 ? "AGENT002_INTERNAL_PAYERS" : `AGENT002_INTERNAL_PAYERS_${k}`;
    const raw = str(env, name, null);
    if (raw === null) continue;
    for (const item of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(item)) throw new Error(`${name}: ${JSON.stringify(item.slice(0, 60))} is not an address`);
      out.add(item.toLowerCase());
    }
  }
  return out;
}

/** How many agents AGENT002_STOCK_DESKS may name. */
export const MAX_DESKS = 10;
/** The most a desk's brief may cost a buyer, as a recipe (src/recipes.mjs): 0.10 USDG. */
export const MAX_DESK_PRICE_ATOMIC = 100_000n;

/**
 * The stock desks (AGENT002_STOCK_DESKS and its caps), against the workers already read: { agents: [agentId...],
 * workers: [the desk-only workers it adds], priceUsdg, priceAtomic, jobCapUsd, dailyCapUsd, maxSteps }. An id with no
 * wallet that is no worker here, or a wallet that is not that worker's, stops the service.
 */
export function desksFromEnv(env, workers, { jobSpendCapUsd }) {
  const raw = str(env, "AGENT002_STOCK_DESKS", null);
  const agents = [], added = [];
  for (const item of (raw || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,12})(?::(0x[0-9a-fA-F]{40}))?$/.exec(item);
    if (!m) throw new Error(`AGENT002_STOCK_DESKS: ${JSON.stringify(item.slice(0, 60))} is not agentId or agentId:wallet`);
    const id = Number(m[1]);
    if (agents.includes(id)) throw new Error(`AGENT002_STOCK_DESKS names agent #${id} twice`);
    const w = workers.find((x) => x.agentId === id);
    if (!w && !m[2]) throw new Error(`AGENT002_STOCK_DESKS: agent #${id} is not one of the workers (AGENT002_WORKER_AGENT_ID_<n> or AGENT002_HIRE_WORKERS): name its wallet (${id}:0x...) for a desk-only worker`);
    if (w && m[2] && w.address.toLowerCase() !== m[2].toLowerCase()) throw new Error(`AGENT002_STOCK_DESKS: agent #${id} is a worker here with another wallet than ${m[2]}`);
    if (!w) added.push({ id: `d${id}`, n: null, agentId: id, address: getAddress(m[2]), hireOnly: true, deskOnly: true });
    agents.push(id);
  }
  if (agents.length > MAX_DESKS) throw new Error(`AGENT002_STOCK_DESKS names ${agents.length} agents; at most ${MAX_DESKS}`);
  const priceUsdg = str(env, "AGENT002_DESK_PRICE_USDG", "0.05");
  const priceAtomic = toAtomic(priceUsdg, USDG.decimals, "AGENT002_DESK_PRICE_USDG");
  if (priceAtomic <= 0n || priceAtomic > MAX_DESK_PRICE_ATOMIC) throw new Error("AGENT002_DESK_PRICE_USDG must be above 0 and at most 0.10");
  // the default job cap: 0.02, or less when half the price or the per-job cap is less
  const jobCapUsd = num(env, "AGENT002_DESK_JOB_CAP_USD", Math.min(0.02, Number(priceUsdg) / 2, jobSpendCapUsd), { min: 0, gt: true });
  const dailyCapUsd = num(env, "AGENT002_DESK_DAILY_CAP_USD", 0.5, { min: 0, gt: true });
  const maxSteps = num(env, "AGENT002_DESK_MAX_STEPS", 2, { integer: true, min: 1 });
  if (maxSteps > 12) throw new Error("AGENT002_DESK_MAX_STEPS must be from 1 to 12");
  if (agents.length) {
    if (jobCapUsd > Number(priceUsdg) / 2) throw new Error("AGENT002_DESK_JOB_CAP_USD cannot be above half of AGENT002_DESK_PRICE_USDG");
    if (jobCapUsd > jobSpendCapUsd) throw new Error("AGENT002_DESK_JOB_CAP_USD cannot be above AGENT002_JOB_SPEND_CAP_USD");
    if (jobCapUsd > dailyCapUsd) throw new Error("AGENT002_DESK_JOB_CAP_USD cannot be above AGENT002_DESK_DAILY_CAP_USD");
  }
  return { agents, workers: added, priceUsdg, priceAtomic, jobCapUsd, dailyCapUsd, maxSteps };
}

/** AGENT002_FACILITATOR_KEY_<n>, by worker id; registered as secrets. */
export function facilitatorKeysFromEnv(env) {
  const keys = {};
  for (let n = 1; n <= MAX_WORKERS; n++) {
    const k = str(env, `AGENT002_FACILITATOR_KEY_${n}`, null);
    if (k) { addSecret(k); keys[`w${n}`] = k; }
  }
  return keys;
}

/**
 * The settings in effect. `workers` (when given, e.g. from the Node CLI's folder) replaces the environment's; a worker
 * in the environment with the same id overrides it.
 */
export function settingsFromEnv(env = {}, { workers: baseWorkers = null } = {}) {
  const openrouterKey = str(env, "OPENROUTER_API_KEY", null);
  if (openrouterKey) addSecret(openrouterKey);
  const rpc = str(env, "AGENT002_RPC", DEFAULTS.rpc);
  if (!/^https?:\/\//.test(rpc)) throw new Error("AGENT002_RPC must be an http(s) URL");
  if (rpc !== PUBLIC_RPC && !isLocal(rpc)) addSecret(rpc); // a private node's URL carries its key
  const s = {
    rateUsdg: str(env, "AGENT002_RATE_USDG", DEFAULTS.rateUsdg),
    ratePriors: str(env, "AGENT002_RATE_PRIORS", DEFAULTS.ratePriors),
    minMinutes: num(env, "AGENT002_MIN_MINUTES", DEFAULTS.minMinutes, { integer: true, min: 1 }),
    maxMinutes: num(env, "AGENT002_MAX_MINUTES", DEFAULTS.maxMinutes, { integer: true, min: 1 }),
    model: str(env, "AGENT002_MODEL", DEFAULTS.model),
    modelPrice: env.AGENT002_MODEL_PRICE ? parsePriceOverride(env.AGENT002_MODEL_PRICE) : null,
    openrouterKey,
    openrouterUrl: str(env, "AGENT002_OPENROUTER_URL", OPENROUTER),
    jobSpendCapUsd: num(env, "AGENT002_JOB_SPEND_CAP_USD", DEFAULTS.jobSpendCapUsd, { min: 0, gt: true }),
    dailySpendCapUsd: num(env, "AGENT002_DAILY_SPEND_CAP_USD", DEFAULTS.dailySpendCapUsd, { min: 0, gt: true }),
    priorsConfirmations: num(env, "AGENT002_PRIORS_CONFIRMATIONS", DEFAULTS.priorsConfirmations, { integer: true, min: 1 }),
    x402QuoteSeconds: DEFAULTS.x402QuoteSeconds,
    priorsQuoteSeconds: num(env, "AGENT002_PRIORS_QUOTE_SECONDS", DEFAULTS.priorsQuoteSeconds, { integer: true, min: 60 }),
    claimWindowHours: DEFAULTS.claimWindowHours,
    workerConcurrency: num(env, "AGENT002_WORKER_CONCURRENCY", DEFAULTS.workerConcurrency, { integer: true, min: 1 }),
    rpc,
    facilitatorUrl: str(env, "AGENT002_FACILITATOR_URL", DEFAULTS.facilitatorUrl),
    publicUrl: str(env, "AGENT002_PUBLIC_URL", null),
    version: str(env, "AGENT002_VERSION", null),
  };
  s.rateUsdgAtomic = toAtomic(s.rateUsdg, USDG.decimals, "AGENT002_RATE_USDG");
  s.ratePriorsAtomic = toAtomic(s.ratePriors, PRIORS.decimals, "AGENT002_RATE_PRIORS");
  if (s.rateUsdgAtomic <= 0n || s.ratePriorsAtomic <= 0n) throw new Error("the rates per minute must be above zero");
  if (s.maxMinutes < s.minMinutes) throw new Error("AGENT002_MAX_MINUTES is below AGENT002_MIN_MINUTES");
  if (s.jobSpendCapUsd > s.dailySpendCapUsd) throw new Error("AGENT002_JOB_SPEND_CAP_USD cannot be above AGENT002_DAILY_SPEND_CAP_USD");
  if (s.publicUrl && !/^https?:\/\//.test(s.publicUrl)) throw new Error("AGENT002_PUBLIC_URL must be an http(s) URL");
  if (s.version && !/^[0-9A-Za-z._+-]{1,64}$/.test(s.version)) throw new Error("AGENT002_VERSION must be a commit or version name (letters, digits, . _ + -)");

  const fromEnv = workersFromEnv(env);
  const byId = new Map((baseWorkers || []).map((w) => [w.id, w]));
  for (const w of fromEnv) byId.set(w.id, { ...byId.get(w.id), ...w });
  // the numbered workers first (w1, w2, ...), then the hire-only ones in the order the variables list them, then the
  // desk-only ones (AGENT002_STOCK_DESKS's agentId:wallet items)
  s.workers = [...[...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })), ...hireWorkersFromEnv(env)];
  s.desks = desksFromEnv(env, s.workers, s);
  s.workers.push(...s.desks.workers);
  const seen = new Set(), ids = new Set();
  for (const w of s.workers) {
    const a = w.address.toLowerCase();
    if (seen.has(a)) throw new Error(`two workers share the wallet ${w.address}: each worker needs its own`);
    seen.add(a);
    if (w.agentId != null) {
      if (ids.has(w.agentId)) throw new Error(`two workers share the agent id ${w.agentId}: each worker is one ERC-8004 identity`);
      ids.add(w.agentId);
    }
  }
  s.internalPayers = internalPayersFromEnv(env);
  s.facilitatorKeys = facilitatorKeysFromEnv(env);
  s.hireFacilitatorKey = str(env, "AGENT002_HIRE_FACILITATOR_KEY", null);
  if (s.hireFacilitatorKey) addSecret(s.hireFacilitatorKey);
  return s;
}
