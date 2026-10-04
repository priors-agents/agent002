// The Node service's store: the in-memory store, written to one JSON file (0600) after every change, so quotes, jobs,
// used PRIORS transactions and the day's model spend survive a restart.
//
// SHORTCUT: the whole state is rewritten on every change. That is fine for thousands of jobs; past that, keep jobs in
// SQLite (node:sqlite) or run the Cloudflare Worker, whose Durable Object stores each key on its own.
import { memoryStore } from "./store.mjs";
import { readJson, writeJson } from "./home.mjs";

export function fileStore(path) {
  const mem = memoryStore(readJson(path, {}) || {});
  const save = () => writeJson(path, mem.snapshot());
  return {
    get: mem.get,
    list: mem.list,
    async put(k, v) { await mem.put(k, v); save(); },
    async delete(k) { await mem.delete(k); save(); },
  };
}
