// Network-free tests of the fixed-price recipes (src/recipes.mjs, served by src/desk.mjs), as a buyer sees them: the
// list in the manifest, the 402 for a recipe's own price to the assigned worker's wallet, a bad input refused with a
// 400 before any 402, a paid run producing its result from the free Priors reads, a quote that pays only for its own
// recipe and input, and the model caps holding for a recipe run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { RECIPES, recipeByKey, checkInput } from "../src/recipes.mjs";
import { priorsToolbox } from "../src/tools.mjs";
import { USDG } from "../src/chain.mjs";
import { W, sign, setup, waitDone } from "./support.mjs";

// What agent002 advertises: each recipe's key, price (USDG) and time limit (minutes).
const OFFER = [
  ["pool-brief", "0.03", "30000", 2],
  ["watch-agents", "0.06", "60000", 3],
  ["agent-file", "0.05", "50000", 3],
  ["deal-check", "0.06", "60000", 3],
  ["score-explainer", "0.04", "40000", 2],
];

const unpaid = async (call, key, body) => {
  const r = await call("POST", `/recipes/${key}`, body);
  return { r, req: r.status === 402 ? decodePaymentRequiredHeader(r.headers.get("payment-required")).accepts[0] : null };
};

test("recipes: a fixed price of at most 0.10 USDG each, a time limit a Worker can run, an input schema its example passes, a model cap of at most half the price", () => {
  assert.deepEqual(RECIPES.map((r) => [r.key, r.price, r.priceAtomic.toString(), r.minutes]), OFFER);
  for (const r of RECIPES) {
    assert.ok(r.priceAtomic > 0n && r.priceAtomic <= 100_000n, `${r.key}: at most 0.10 USDG (a default agent setup's limit per use)`);
    assert.ok(r.minutes >= 1 && r.minutes <= 14, `${r.key}: within a JobRunner alarm`);
    assert.ok(r.spendCapUsd > 0 && r.spendCapUsd <= Number(r.price) / 2, `${r.key}: model cap at most half the price`);
    assert.equal(r.input.type, "object");
    assert.ok(r.title && r.description && r.returns, r.key);
    const input = checkInput(r, r.example);
    const task = r.task(input);
    for (const id of [input.agent, ...(input.agents || [])].filter((x) => x !== undefined)) assert.match(task, new RegExp(`#${id}\\b`), `${r.key}: the task names agent #${id}`);
  }
  assert.equal(recipeByKey("nope"), null);
});

test("recipe input: digit strings are read as ids, text is trimmed, a missing, wrong, duplicate or unknown field is a 400", () => {
  assert.deepEqual(checkInput(recipeByKey("watch-agents"), { agents: ["437", 462], lastScores: { 437: 120 } }), { agents: [437, 462], lastScores: { 437: 120 } });
  assert.deepEqual(checkInput(recipeByKey("deal-check"), { agents: [7], deal: "  a data feed for 2 USDG  " }), { agents: [7], deal: "a data feed for 2 USDG" });
  assert.deepEqual(checkInput(recipeByKey("pool-brief"), {}), {});
  const refused = (key, body) => assert.throws(() => checkInput(recipeByKey(key), body), (e) => e.status === 400 && e.code === "bad_input", `${key} ${JSON.stringify(body)}`);
  refused("agent-file", {});
  refused("agent-file", { agent: -1 });
  refused("agent-file", { agent: 1.5 });
  refused("agent-file", { agent: "abc" });
  refused("agent-file", { agent: 437, extra: 1 });
  refused("score-explainer", { agent: null });
  refused("watch-agents", { agents: [] });
  refused("watch-agents", { agents: Array.from({ length: 11 }, (_, i) => i + 1) });
  refused("watch-agents", { agents: [437, "437"] });
  refused("watch-agents", { agents: [437], lastScores: { 462: 10 } });
  refused("watch-agents", { agents: [437], lastScores: { 437: 1001 } });
  refused("deal-check", { agents: "437" });
  refused("deal-check", { agents: [437], deal: "x".repeat(301) });
  refused("pool-brief", { limit: 5 });
});

test("manifest: every recipe with its key, title, price, time limit, input and endpoint; GET /recipes and GET /recipes/<key> say the same", async () => {
  const { call } = setup();
  const m = await (await call("GET", "/manifest")).json();
  assert.deepEqual(m.recipes.map((r) => [r.key, r.price.USDG, r.priceAtomic.USDG, r.timeLimitMinutes]), OFFER);
  for (const r of m.recipes) {
    assert.equal(r.endpoint, `POST /recipes/${r.key}`);
    assert.equal(r.input.type, "object");
    assert.ok(r.title && r.description && r.returns && r.example, r.key);
    assert.ok(r.modelSpendCapUsd <= Number(r.price.USDG) / 2);
  }
  assert.equal(m.endpoints.recipe, "POST /recipes/{key}");
  assert.equal(m.endpoints.hire, "POST /jobs", "hiring by the minute is still offered");
  assert.deepEqual((await (await call("GET", "/recipes")).json()).recipes, m.recipes);
  assert.deepEqual(await (await call("GET", "/recipes/agent-file")).json(), m.recipes.find((r) => r.key === "agent-file"));
  assert.equal((await call("GET", "/recipes/nope")).status, 404);
});

test("402 for a recipe: exactly its price in USDG on eip155:4663, payTo the wallet of the worker it was assigned to, the recipe's own resource", async () => {
  const { call } = setup({ AGENT002_PUBLIC_URL: "https://agent002.example" });
  for (const [i, [key, , atomic]] of OFFER.entries()) {
    const { r, req } = await unpaid(call, key, recipeByKey(key).example);
    assert.equal(r.status, 402, key);
    const body = await r.json();
    assert.deepEqual([req.scheme, req.network, req.asset, req.amount], ["exact", "eip155:4663", USDG.address, atomic], key);
    // quotes go round the fleet: w1, w2, w3, w1, ...
    assert.equal(req.payTo, W[i % 3].address, key);
    assert.equal(body.quote.worker.wallet, req.payTo);
    assert.equal(body.quote.recipe, key);
    assert.equal(body.resource.url, `https://agent002.example/recipes/${key}`);
    assert.equal(req.extra.quote, body.quote.id);
  }
});

test("a bad request is refused with a 400 (or 404) before any 402: nothing is asked to be paid, no quote is kept", async () => {
  const { call, store, desk } = setup();
  const cases = [
    ["agent-file", {}, 400, "bad_input"],
    ["agent-file", { agent: "abc" }, 400, "bad_input"],
    ["watch-agents", { agents: [] }, 400, "bad_input"],
    ["watch-agents", { agents: Array.from({ length: 11 }, (_, i) => i) }, 400, "bad_input"],
    ["deal-check", { agents: [437], deal: "x".repeat(301) }, 400, "bad_input"],
    ["score-explainer", { agent: 437, minutes: 5 }, 400, "bad_input"],
    ["pool-brief", { focus: "defaults" }, 400, "bad_input"],
    ["pool-brief", { payment: { token: "PRIORS", txHash: `0x${"1".repeat(64)}` } }, 400, "bad_payment"],
    ["no-such-recipe", {}, 404, "unknown_recipe"],
  ];
  for (const [key, body, status, code] of cases) {
    const r = await call("POST", `/recipes/${key}`, body);
    assert.equal(r.status, status, `${key} ${JSON.stringify(body)}`);
    assert.equal(r.headers.get("payment-required"), null, "no 402");
    assert.equal((await r.json()).code, code);
  }
  const nonJson = await call("POST", "/recipes/agent-file", undefined, {});
  assert.equal(nonJson.status, 400);
  const broken = await desk.handle(new Request("http://agent002.test/recipes/agent-file", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }));
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).code, "bad_json");
  assert.deepEqual([...(await store.list("quote:"))], [], "no quote for a bad request");
});

/** The free Priors reads a run uses: the check API and the hosted MCP server, answered here. */
function priorsReads(seen) {
  const record = 'Agent #437 "testagent" (owner 0x1111111111111111111111111111111111111111)\nRecord: 12 loans repaid (3 qualified), 61.00 USDG repaid in total. Score 140/1000. Never defaulted.';
  return async (url, init) => {
    if (url.startsWith("https://priors.trade/api/check")) {
      seen.push(url);
      return Response.json({ verdict: "repaid", agents: [{ agentId: 437, name: "testagent", record: { loansRepaid: 12, defaulted: false } }] });
    }
    const body = JSON.parse(init.body);
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "mcp-session-id": "s1" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: ["agent_record", "score_of", "pool_stats"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } });
    if (body.method === "tools/call") {
      seen.push(`${body.params.name} ${JSON.stringify(body.params.arguments)}`);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: body.params.name === "agent_record" ? record : "?" }] } });
    }
    throw new Error(body.method);
  };
}

/** A model that reads the agent id from the recipe's task, calls the check and the record, then writes from them. */
function scriptedModel(seen) {
  return {
    name: "scripted",
    estimateUsd: () => 0.0001,
    maxTokensFor: (budget) => (budget + 1e-12 >= 0.0001 ? 500 : 0),
    async complete({ system, history, tools }) {
      seen.push({ system, tools: tools.map((t) => t.name) });
      const last = history[history.length - 1];
      if (!last.results) {
        const id = Number(/agent #(\d+)/.exec(history[0].text)[1]);
        return { text: "", calls: [{ id: "c1", name: "priors_check", input: { agent: id } }, { id: "c2", name: "agent_record", input: { agent_id: id } }], costUsd: 0.0001 };
      }
      return { text: `# Agent file\n${last.results.map((x) => x.text).join("\n")}`, calls: [], costUsd: 0.0001 };
    },
  };
}

test("a paid recipe run: settled to the assigned worker, run on the free Priors reads, its result and receipt at GET /jobs/{id}", async () => {
  const reads = [], model = [];
  const s = setup({}, { modelFor: async () => scriptedModel(model), toolbox: () => priorsToolbox({ fetchImpl: priorsReads(reads) }) });
  const buyer = ethers.Wallet.createRandom();
  const input = { agent: 437 };
  const { req } = await unpaid(s.call, "agent-file", input);
  const signature = await sign(buyer, req);
  const paid = await s.call("POST", "/recipes/agent-file", input, { "payment-signature": signature });
  assert.equal(paid.status, 201, await paid.clone().text());
  const settlement = decodePaymentResponseHeader(paid.headers.get("payment-response"));
  assert.equal(settlement.success, true);
  const created = await paid.json();
  assert.match(created.id, /^job_[0-9a-f]{32}$/);
  assert.deepEqual(s.facilitator.settled.map((x) => [x.to, x.amount, x.from]), [[W[0].address, "50000", buyer.address]]);

  const job = await waitDone(s.call, created.id);
  assert.equal(job.status, "done");
  assert.deepEqual(job.recipe, { key: "agent-file", title: recipeByKey("agent-file").title });
  assert.deepEqual(job.input, { agent: 437 });
  assert.match(job.result, /Agent #437 "testagent"/);
  assert.match(job.result, /12 loans repaid/);
  assert.deepEqual(reads, ["https://priors.trade/api/check?agent=437", 'agent_record {"agent_id":437}']);
  assert.match(model[0].system, /fixed price/);
  assert.ok(model[0].tools.includes("priors_check") && model[0].tools.includes("agent_record"));
  const rc = job.receipt;
  assert.deepEqual([rc.payer, rc.amount, rc.amountAtomic, rc.token, rc.method, rc.txHash, rc.worker, rc.workerId], [buyer.address, "0.05", "50000", "USDG", "x402", settlement.transaction, W[0].address, "w1"]);
  assert.deepEqual([rc.minutesBought, rc.timeLimitMinutes, rc.modelSpendCapUsd, rc.modelSpendUsd], [null, 3, 0.025, 0.0002]);

  // the same signed payment again returns the same job; nothing settles twice
  const again = await s.call("POST", "/recipes/agent-file", input, { "payment-signature": signature });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, created.id);
  assert.equal(s.facilitator.settled.length, 1);
  const m = await (await s.call("GET", "/manifest")).json();
  assert.equal(m.workers[0].earned.USDG, "0.05");
});

test("a recipe's quote pays for that recipe and that input only: another input, recipe or a job by the minute is refused before settling", async () => {
  const { call, facilitator } = setup();
  const buyer = ethers.Wallet.createRandom();
  const { req } = await unpaid(call, "agent-file", { agent: 437 });
  const pay = async (path, body) => call("POST", path, body, { "payment-signature": await sign(buyer, req) });
  for (const [path, body] of [["/recipes/agent-file", { agent: 438 }], ["/recipes/score-explainer", { agent: 437 }], ["/jobs", { minutes: 3, task: "Check agent 437." }], ["/jobs", { minutes: 3, task: recipeByKey("agent-file").task({ agent: 437 }) }]]) {
    const r = await pay(path, body);
    assert.equal(r.status, 400, path);
    assert.equal((await r.json()).code, "quote_mismatch");
  }
  // and a job by the minute's quote does not pay for a recipe
  const job = await call("POST", "/jobs", { minutes: 3, task: "anything" });
  const jobReq = decodePaymentRequiredHeader(job.headers.get("payment-required")).accepts[0];
  const r = await call("POST", "/recipes/agent-file", { agent: 437 }, { "payment-signature": await sign(buyer, jobReq) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "quote_mismatch");
  assert.equal(facilitator.settled.length, 0);
});

/** A model that never stops calling tools, at a fixed price per call. */
const greedy = (costUsd) => ({
  name: "greedy",
  estimateUsd: () => costUsd,
  maxTokensFor: (budget) => (budget + 1e-12 >= costUsd ? 500 : 0),
  complete: async () => ({ text: "", calls: [{ id: "c", name: "time_left", input: {} }], costUsd }),
});

test("model spend: a recipe run stops at half its price, and never above AGENT002_JOB_SPEND_CAP_USD", async () => {
  for (const [over, cap, spent] of [[{}, 0.015, 0.012], [{ AGENT002_JOB_SPEND_CAP_USD: "0.01" }, 0.01, 0.006]]) {
    const { call } = setup(over, { modelFor: async () => greedy(0.006) });
    const buyer = ethers.Wallet.createRandom();
    const { req } = await unpaid(call, "pool-brief", {});
    const r = await call("POST", "/recipes/pool-brief", {}, { "payment-signature": await sign(buyer, req) });
    assert.equal(r.status, 201);
    const job = await waitDone(call, (await r.json()).id);
    assert.equal(job.receipt.modelSpendCapUsd, cap);
    assert.equal(job.receipt.modelSpendUsd, spent);
    assert.equal(job.receipt.stoppedBy, "budget");
  }
});

test("daily cap: when the day's model budget cannot hold another job, a recipe is refused with a 503 and no 402", async () => {
  const { call, store, settings } = setup();
  await store.put("ledger", { day: new Date().toISOString().slice(0, 10), spentUsd: settings.dailySpendCapUsd - 0.01, reserved: {} });
  const r = await call("POST", "/recipes/pool-brief", {});
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("payment-required"), null);
  assert.equal((await r.json()).code, "daily_cap");
});
