// What every Node command needs: the folder, the settings, the chain, the workers, the log. The chain is the sandbox
// while one runs (sandbox.json), otherwise AGENT002_RPC (mainnet's public RPC by default). A sandbox that was started
// and is no longer answering, or was stopped, is an error until it is restarted or sandbox.json is deleted: never a
// silent switch to mainnet. The sandbox keeps the workers' fork-only agent ids in sandbox.json; fleet.json holds the
// mainnet ones.
import { existsSync } from "node:fs";
import { homeDir, ensureHome, pathOf, readJson, writeJson } from "./home.mjs";
import { PUBLIC_RPC } from "./chain.mjs";
import { makeProvider, isSandbox } from "./eth.mjs";
import { loadWorkerFile } from "./workers.mjs";
import { settingsFromEnv } from "./settings.mjs";
import { makeLog } from "./log.mjs";

export async function makeContext({ env = process.env, quiet = false } = {}) {
  const home = ensureHome(homeDir(env));
  const log = makeLog({ file: pathOf(home, "agent002.log"), quiet });
  const sbPath = pathOf(home, "sandbox.json");
  const sb = existsSync(sbPath) ? readJson(sbPath) : null;
  const envRpc = String(env.AGENT002_RPC || "").trim();
  let rpc = envRpc || PUBLIC_RPC, sandbox = false;
  if (sb?.rpc && !envRpc) {
    const stopped = () => new Error(`the sandbox at ${sb.rpc} is not running${sb.stopped ? " (it was stopped)" : ""}. Start it again with \`agent002 sandbox\` (a fresh fork), or delete ${sbPath} to use mainnet.`);
    if (sb.stopped) throw stopped();
    const p = makeProvider(sb.rpc);
    const up = await isSandbox(p);
    p.destroy();
    if (!up) throw stopped();
    rpc = sb.rpc;
    sandbox = true;
  } else if (envRpc) {
    const p = makeProvider(rpc);
    sandbox = await isSandbox(p);
    p.destroy();
  }
  const fleet = readJson(pathOf(home, "fleet.json"), {}) || {};
  const ids = (sandbox ? sb?.agentIds : fleet.agentIds) || {};
  const fileWorkers = loadWorkerFile(home).map((w) => ({ ...w, agentId: ids[w.id] ?? null }));
  const settings = settingsFromEnv({ ...env, AGENT002_RPC: rpc }, { workers: fileWorkers });
  if (sandbox) for (const w of settings.workers) w.agentId = ids[w.id] ?? null; // the fork's ids, never mainnet's
  const provider = makeProvider(rpc);
  return {
    home, log, settings, sandbox, rpc, provider, sandboxFile: sandbox ? sb : null,
    /** Remember a worker's agent id: in sandbox.json on a sandbox, in fleet.json otherwise. */
    saveAgentId(workerId, agentId) {
      const path = sandbox ? sbPath : pathOf(home, "fleet.json");
      const cur = readJson(path, {}) || {};
      writeJson(path, { ...cur, agentIds: { ...(cur.agentIds || {}), [workerId]: agentId } });
      const w = settings.workers.find((x) => x.id === workerId);
      if (w) w.agentId = agentId;
    },
    close() { provider.destroy(); },
  };
}
