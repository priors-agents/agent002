// The workers' keys, in Node: three keys made by `agent002 init`, kept in .agent002/workers.json (0600), never printed.
// Only their addresses are ever shown. A worker key signs only two things: its ERC-8004 registration (`agent002
// join`) and its registration with the Priors facilitator (`agent002 merchant register`). Serving jobs needs no key at
// all: a payment only needs the address it goes to, so a deployment can run with addresses alone.
//
// On a hosting platform, AGENT002_WORKER_KEY_<n> (a secret) or AGENT002_WORKER_ADDRESS_<n> replaces worker n of the
// file (src/settings.mjs).
import { existsSync, statSync } from "node:fs";
import { ethers } from "ethers";
import { ensureHome, pathOf, readJson, writeJson } from "./home.mjs";
import { addSecret } from "./secrets.mjs";

export const FLEET_SIZE = 3;

export function createWorkers(home, n = FLEET_SIZE) {
  ensureHome(home);
  const path = pathOf(home, "workers.json");
  if (existsSync(path)) throw new Error(`${path} already exists: agent002 never replaces worker keys (their wallets may hold money). Move it away first if you really want new ones.`);
  const workers = [];
  for (let i = 1; i <= n; i++) {
    const w = ethers.Wallet.createRandom();
    addSecret(w.privateKey);
    workers.push({ id: `w${i}`, address: w.address, privateKey: w.privateKey });
  }
  writeJson(path, { workers, createdAt: new Date().toISOString(), note: "agent002's worker keys. Never share or commit this file." });
  return { path, workers: workers.map(({ id, address }) => ({ id, address })) };
}

/**
 * The workers in workers.json, as settings take them ({ id, n, address, key }), or [] when there is no file. Refused
 * if others can read it.
 */
export function loadWorkerFile(home) {
  const path = pathOf(home, "workers.json");
  if (!existsSync(path)) return [];
  const mode = statSync(path).mode & 0o077;
  if (mode && process.platform !== "win32") throw new Error(`${path} can be read by other users (mode ${(statSync(path).mode & 0o777).toString(8)}): run chmod 600 on it`);
  const raw = readJson(path);
  return (raw?.workers || []).map((w, i) => {
    addSecret(w.privateKey);
    let wallet;
    try { wallet = new ethers.Wallet(String(w.privateKey)); } catch (_) { throw new Error(`${path}: worker ${w.id || i + 1} does not hold a valid key`); }
    if (w.address && w.address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`${path}: worker ${w.id}'s address does not match its key`);
    return { id: w.id || `w${i + 1}`, n: i + 1, address: wallet.address, key: wallet.privateKey, agentId: null };
  });
}

/** A worker's signer: its key, connected to `provider`. */
export function signerOf(worker, provider) {
  if (!worker.key) throw new Error(`worker ${worker.id} has no key here (only its address): sign from where its key is (workers.json or AGENT002_WORKER_KEY_${worker.n})`);
  return new ethers.Wallet(worker.key, provider);
}
