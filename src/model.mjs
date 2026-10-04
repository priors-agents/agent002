// The model a job runs on: any OpenRouter model (its OpenAI-compatible /chat/completions, with tools), or a
// deterministic stub for tests (AGENT002_MODEL=stub). Plain fetch, no SDK; runs in Node and in a Cloudflare Worker.
//
// Every call is priced before it is made, so the per-job cap is a hard limit and not a hope: the model's per-token
// prices come from OpenRouter's public endpoint list (the highest any of its providers charges), the prompt is
// counted at two characters a token (more tokens than any tokenizer makes of text, so the estimate is on the high
// side), and `max_tokens` is set so that even a reply of that length fits what the job has left. After the call, the
// spend counted is what OpenRouter says it charged (`usage.cost`), or the token counts at those prices.
import { redact } from "./secrets.mjs";
import { usd8 } from "./money.mjs";

export const OPENROUTER = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-6-luna";
export const MAX_TOKENS = 1500; // the longest reply one call may write
export const MIN_TOKENS = 64; //   below this, a call is not worth making: the job stops for budget

/** Prompt characters counted as tokens, on the high side. */
export const promptTokens = (chars) => Math.ceil(chars / 2);

/** Worst-case cost of one call, in USD, at `pricing` ({ prompt, completion, request } per token / per call). */
export function estimateUsd(pricing, promptChars, maxTokens) {
  return usd8(promptTokens(promptChars) * pricing.prompt + maxTokens * pricing.completion + (pricing.request || 0));
}

/** The longest reply that keeps one call within `budgetUsd`. */
export function maxTokensFor(pricing, budgetUsd, promptChars) {
  const left = budgetUsd - promptTokens(promptChars) * pricing.prompt - (pricing.request || 0);
  if (!(left > 0) || !(pricing.completion > 0)) return 0;
  return Math.max(0, Math.min(MAX_TOKENS, Math.floor(left / pricing.completion)));
}

/** "0.10,0.50" (USD per million input and output tokens) -> per-token prices. */
export function parsePriceOverride(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(String(s || ""));
  if (!m) throw new Error("AGENT002_MODEL_PRICE must be two numbers: USD per million input tokens, then output tokens (e.g. 0.10,0.50)");
  return { prompt: Number(`${m[1]}e-6`), completion: Number(`${m[2]}e-6`), request: 0, reasoning: false };
}

/**
 * A model's per-token prices on OpenRouter: the highest any of its endpoints charges, its price overrides included
 * (some models cost more past a prompt size), so the estimate is never under what a call can cost.
 */
export async function openrouterPricing(model, { fetchImpl = globalThis.fetch, baseUrl = OPENROUTER } = {}) {
  const r = await fetchImpl(`${baseUrl}/models/${encodeURI(model)}/endpoints`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`OpenRouter does not list the model ${model} (HTTP ${r.status})`);
  const j = await r.json();
  const endpoints = j?.data?.endpoints || [];
  let prompt = 0, completion = 0, request = 0;
  const params = new Set();
  for (const e of endpoints) {
    const p = e.pricing || {};
    for (const x of [p, ...(Array.isArray(p.overrides) ? p.overrides : [])]) {
      prompt = Math.max(prompt, Number(x.prompt) || 0);
      completion = Math.max(completion, Number(x.completion) || 0, Number(x.internal_reasoning) || 0);
      request = Math.max(request, Number(x.request) || 0);
    }
    for (const s of e.supported_parameters || []) params.add(s);
  }
  if (!endpoints.length || !(completion > 0)) throw new Error(`OpenRouter gives no price for ${model}: set AGENT002_MODEL_PRICE to bound its spend`);
  if (!params.has("tools")) throw new Error(`${model} does not take tools on OpenRouter: pick a model that does`);
  return { prompt, completion, request, reasoning: params.has("reasoning") };
}

/** An OpenRouter model. `pricing` from openrouterPricing() or parsePriceOverride(). */
export function openrouterModel({ apiKey, model, pricing, baseUrl = OPENROUTER, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set: the workers need it to run jobs (or AGENT002_MODEL=stub for tests)");
  return {
    name: model,
    estimateUsd: (promptChars, maxTokens) => estimateUsd(pricing, promptChars, maxTokens),
    maxTokensFor: (budgetUsd, promptChars) => maxTokensFor(pricing, budgetUsd, promptChars),
    async complete({ system, history, tools, maxTokens, signal }) {
      const messages = [{ role: "system", content: system }];
      for (const h of history) {
        if (h.results) for (const x of h.results) messages.push({ role: "tool", tool_call_id: x.id, content: x.text });
        else if (h.calls) messages.push({ role: "assistant", content: h.text || null, tool_calls: h.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input || {}) } })) });
        else messages.push({ role: h.role, content: h.text });
      }
      const body = {
        model,
        messages,
        max_tokens: maxTokens,
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
        // a reasoning model thinks briefly and keeps its reasoning to itself: fewer tokens billed, more left for the answer
        ...(pricing.reasoning ? { reasoning: { effort: "low", exclude: true } } : {}),
      };
      const r = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-title": "agent002", "http-referer": "https://github.com/priors-agents/agent002" },
        body: JSON.stringify(body),
        signal,
      });
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(`OpenRouter answered HTTP ${r.status}: ${redact(text).slice(0, 300)}`), { status: r.status });
      let j;
      try { j = JSON.parse(text); } catch (_) { throw new Error("OpenRouter answered with something other than JSON"); }
      if (j.error) throw Object.assign(new Error(`OpenRouter: ${redact(String(j.error.message || j.error.code)).slice(0, 300)}`), { status: Number(j.error.code) || 502 });
      const m = j.choices?.[0]?.message || {};
      const calls = (m.tool_calls || []).map((c) => {
        let input = {};
        try { input = JSON.parse(c.function?.arguments || "{}"); } catch (_) { /* the model wrote bad JSON: the tool gets {} */ }
        return { id: c.id, name: c.function?.name, input };
      });
      const u = j.usage || {};
      const costUsd = typeof u.cost === "number" && Number.isFinite(u.cost)
        ? u.cost
        : (Number(u.prompt_tokens) || 0) * pricing.prompt + (Number(u.completion_tokens) || 0) * pricing.completion + (pricing.request || 0);
      return { text: m.content || "", calls, costUsd: usd8(costUsd), usage: { promptTokens: u.prompt_tokens ?? null, completionTokens: u.completion_tokens ?? null } };
    },
  };
}

/** What the stub "spends" per call: small, fixed, so the spend caps and receipts are exercised deterministically. */
export const STUB_COST_USD = 0.0001;

/**
 * The deterministic stub (AGENT002_MODEL=stub): no language model and no network. Its first step calls the local
 * `time_left` tool, its second answers with a fixed text built from the task. Same task, same answer.
 */
export function stubModel() {
  return {
    name: "stub",
    estimateUsd: () => STUB_COST_USD,
    maxTokensFor: (budgetUsd) => (budgetUsd + 1e-12 >= STUB_COST_USD ? 256 : 0),
    async complete({ history }) {
      const last = history[history.length - 1];
      const task = history.find((h) => h.role === "user" && typeof h.text === "string")?.text || "";
      if (last.results) {
        const tl = last.results.find((x) => x.name === "time_left");
        return {
          text: `agent002 stub answer (deterministic, no language model) for the task: "${task.slice(0, 200)}". Steps: 2; tool used: ${tl ? "time_left" : "none"}.`,
          calls: [],
          costUsd: STUB_COST_USD,
          usage: { promptTokens: 0, completionTokens: 0 },
        };
      }
      return { text: "", calls: [{ id: `stub-${history.length}`, name: "time_left", input: {} }], costUsd: STUB_COST_USD, usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
}

/**
 * The model the settings name: "stub", or an OpenRouter model id. Prices come from AGENT002_MODEL_PRICE when set,
 * else from OpenRouter (cached per process for an hour).
 */
const pricingCache = new Map();
export async function makeModel(settings, { fetchImpl = globalThis.fetch } = {}) {
  if (settings.model === "stub") return stubModel();
  let pricing = settings.modelPrice;
  if (!pricing) {
    const hit = pricingCache.get(settings.model);
    if (hit && hit.at > Date.now() - 3600_000) pricing = hit.pricing;
    else {
      pricing = await openrouterPricing(settings.model, { fetchImpl, baseUrl: settings.openrouterUrl });
      pricingCache.set(settings.model, { pricing, at: Date.now() });
    }
  }
  return openrouterModel({ apiKey: settings.openrouterKey, model: settings.model, pricing, baseUrl: settings.openrouterUrl, fetchImpl });
}
