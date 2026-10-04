// agent002 keeps everything in one folder: ./.agent002 by default, AGENT002_HOME to move it. Node only (a Cloudflare
// Worker keeps its state in a Durable Object and its keys in secrets). Every file is owner-only (0600).
//
//   workers.json        the three workers' keys. They leave this file only to sign (join, merchant register).
//   fleet.json          the workers' mainnet ERC-8004 agent ids, once `agent002 join` registered them.
//   merchant.json       each worker's API key with the Priors facilitator (`agent002 merchant register`).
//   state.json          the service's state on mainnet: quotes, jobs, used PRIORS transactions, the day's model spend.
//   sandbox.json        from `agent002 sandbox` on: the fork's RPC, its fork-only facilitator key and the workers'
//                       fork-only agent ids; once the sandbox is stopped it says so, and commands refuse until a new
//                       one starts or the file is deleted (never a silent switch to mainnet).
//   sandbox-state.json  the service's state on the sandbox fork, apart from mainnet's.
//   agent002.log        what the service did, every secret redacted.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

export function homeDir(env = process.env) {
  return resolve(env.AGENT002_HOME || ".agent002");
}

export function ensureHome(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch (_) { /* a filesystem without modes */ }
  return dir;
}

export const pathOf = (dir, name) => join(dir, name);

export function readJson(path, fallback = null) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${path} is not valid JSON (${e.message})`); }
}

/** Written to a temporary file then renamed, so a crash never leaves half a file; owner-only by default. */
export function writeJson(path, obj, mode = 0o600) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode });
  renameSync(tmp, path);
  try { chmodSync(path, mode); } catch (_) { /* a filesystem without modes */ }
}
