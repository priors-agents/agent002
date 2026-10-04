// Running jobs in the same process as the service (Node). The service hands a job over with start(); the job runs in
// the background (src/agent.mjs) and its outcome comes back through finish(). In a Cloudflare Worker the same role is
// played by one JobRunner Durable Object per job (src/worker.mjs), so a job outlives the request that paid for it.
import { runJob } from "./agent.mjs";
import { makeModel } from "./model.mjs";
import { priorsToolbox } from "./tools.mjs";
import { safeMessage } from "./secrets.mjs";

export function localRunner({ settings, log = null, toolbox = () => priorsToolbox(), modelFor = () => makeModel(settings) }) {
  return {
    start(job, { finish, progress }) {
      setImmediate(async () => {
        const worker = settings.workers.find((w) => w.id === job.workerId);
        let outcome;
        try {
          const model = await modelFor();
          outcome = await runJob({
            job, worker, model, toolbox: toolbox(), spendCapUsd: settings.jobSpendCapUsd, deadline: job.deadline,
            spentUsd: job.modelSpendUsd || 0, onSpend: (s) => { void progress(job.id, s); }, log,
          });
        } catch (e) {
          const t = new Date().toISOString();
          outcome = { status: "failed", result: null, error: safeMessage(e), modelSpendUsd: job.modelSpendUsd || 0, startedAt: t, finishedAt: t };
        }
        try { await finish(job.id, outcome); } catch (e) { log?.error?.(`job ${job.id}: could not record its outcome: ${safeMessage(e)}`); }
      });
    },
  };
}
