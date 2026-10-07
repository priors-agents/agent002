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
//   OPENROUTER_API_KEY             secret: the model provider's key
import { computeAddress, getAddress } from "ethers";
import { PUBLIC_RPC, USDG, PRIORS, isAddress } from "./chain.mjs";
import { toAtomic } from "./money.mjs";
import { DEFAULT_MODEL, OPENROUTER, parsePriceOverride } from "./model.mjs";
import { addSecret } from "./secrets.mjs";

export const FACILITATOR = "https://facilitator.priors.trade";
export const MAX_WORKERS = 9;

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
  s.workers = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const seen = new Set();
  for (const w of s.workers) {
    const a = w.address.toLowerCase();
    if (seen.has(a)) throw new Error(`two workers share the wallet ${w.address}: each worker needs its own`);
    seen.add(a);
  }
  s.facilitatorKeys = facilitatorKeysFromEnv(env);
  return s;
}
