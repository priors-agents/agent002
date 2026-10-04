// agent002 as a Cloudflare Worker: the same service as `agent002 serve` (src/desk.mjs), on Durable Objects.
//
//   Desk        one instance (named "desk"): every request goes to it. It keeps the quotes, the jobs, the queue, the
//               PRIORS transactions already used and the day's model spend in its storage, one key each.
//   JobRunner   one instance per job: the Desk hands it a paid job (an RPC call), it sets an alarm and runs the job in
//               the alarm handler, which may run for 15 minutes of wall time (so AGENT002_MAX_MINUTES is at most 14
//               here). It keeps the outcome before reporting it, so a retried alarm reports the same outcome and
//               never runs the job twice.
//
// Settings come from wrangler.jsonc's `vars` and from secrets (src/settings.mjs): the workers' wallet addresses and
// ERC-8004 ids as vars; OPENROUTER_API_KEY and each worker's AGENT002_FACILITATOR_KEY_<n> as secrets. The Worker needs
// no worker key: it only receives payments. (A Worker entry module exports only handlers and classes: the helpers
// below stay private.)
import { DurableObject } from "cloudflare:workers";
import { priorsFacilitatorClient } from "@priors/x402";
import { makeDesk, json } from "./desk.mjs";
import { settingsFromEnv } from "./settings.mjs";
import { jsonRpc } from "./rpc.mjs";
import { runJob } from "./agent.mjs";
import { makeModel } from "./model.mjs";
import { priorsToolbox } from "./tools.mjs";
import { redact, safeMessage } from "./secrets.mjs";

/** A JobRunner's alarm has 15 minutes of wall time: a job can be at most 14 minutes long here. */
const MAX_MINUTES_IN_A_WORKER = 14;

function workerSettings(env) {
  const s = settingsFromEnv(env);
  if (!s.workers.length) throw new Error("no workers: set AGENT002_WORKER_ADDRESS_1..3 in wrangler.jsonc vars (agent002 wrangler-secrets prints them)");
  if (s.maxMinutes > MAX_MINUTES_IN_A_WORKER) throw new Error(`AGENT002_MAX_MINUTES is ${s.maxMinutes}: in a Worker a job runs in a Durable Object alarm (15 minutes of wall time), so at most ${MAX_MINUTES_IN_A_WORKER}`);
  return s;
}

const log = {
  info: (m) => console.log(redact(m)),
  error: (m) => console.error(redact(m)),
};

/** The store interface (src/store.mjs) on a Durable Object's storage. */
const doStore = (storage) => ({
  get: (k) => storage.get(k),
  put: (k, v) => storage.put(k, v),
  delete: (k) => storage.delete(k),
  list: (prefix) => storage.list({ prefix }),
});

const deskOf = (env) => env.DESK.get(env.DESK.idFromName("desk"));

export class Desk extends DurableObject {
  build() {
    const settings = workerSettings(this.env);
    const clients = new Map();
    for (const w of settings.workers) {
      const apiKey = settings.facilitatorKeys[w.id];
      if (apiKey) clients.set(w.id, priorsFacilitatorClient({ url: settings.facilitatorUrl, apiKey }));
    }
    return makeDesk({
      settings,
      store: doStore(this.ctx.storage),
      runner: { start: (job) => this.env.JOBS.get(this.env.JOBS.idFromName(job.id)).start(job) },
      // a worker without AGENT002_FACILITATOR_KEY_<n> takes PRIORS jobs only (it is never named in a 402)
      facilitatorFor: (w) => clients.get(w.id) || null,
      rpc: jsonRpc(settings.rpc),
      log,
    });
  }

  desk() {
    this.cached ??= this.build();
    return this.cached;
  }

  async fetch(request) {
    let desk;
    try { desk = this.desk(); } catch (e) {
      return json(503, { error: `agent002 is not configured: ${safeMessage(e)}`, code: "not_configured" });
    }
    return desk.handle(request);
  }

  /** A JobRunner's outcome. */
  async finish(jobId, outcome) { await this.desk().finish(jobId, outcome); }
}

export class JobRunner extends DurableObject {
  /** The Desk hands over a paid job: kept, then run in the alarm. Starting twice is harmless. */
  async start(job) {
    if (await this.ctx.storage.get("job")) return;
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const job = await this.ctx.storage.get("job");
    if (!job) return;
    let outcome = await this.ctx.storage.get("outcome");
    if (!outcome) {
      const spent = (await this.ctx.storage.get("spent")) ?? job.modelSpendUsd ?? 0;
      try {
        const settings = workerSettings(this.env);
        const worker = settings.workers.find((w) => w.id === job.workerId);
        if (!worker) throw new Error(`worker ${job.workerId} is no longer configured`);
        outcome = await runJob({
          job, worker, model: await makeModel(settings), toolbox: priorsToolbox(), spendCapUsd: settings.jobSpendCapUsd,
          deadline: job.deadline, spentUsd: spent, log,
          onSpend: (s) => { void this.ctx.storage.put("spent", s); }, // a retried alarm resumes with what was spent
        });
      } catch (e) {
        const t = new Date().toISOString();
        outcome = { status: "failed", result: null, error: safeMessage(e), modelSpendUsd: spent, startedAt: t, finishedAt: t };
      }
      await this.ctx.storage.put("outcome", outcome);
    }
    await deskOf(this.env).finish(job.id, outcome); // if this throws, the alarm is retried and reports the kept outcome
    await this.ctx.storage.deleteAll();
  }
}

export default {
  fetch(request, env) {
    return deskOf(env).fetch(request);
  },
};
