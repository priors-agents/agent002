// One log for everything the agent does: to stderr (unless quiet) and appended to .agent002/agent002.log (Node only).
// Every line is redacted (src/secrets.mjs).
import { appendFileSync } from "node:fs";
import { redact } from "./secrets.mjs";

export function makeLog({ file = null, quiet = false } = {}) {
  const line = (level, args) => {
    const text = redact(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)))).join(" "));
    const out = `${new Date().toISOString()} ${level} ${text}`;
    if (file) { try { appendFileSync(file, out + "\n", { mode: 0o600 }); } catch (_) { /* the log is best effort */ } }
    if (!quiet && level !== "debug") process.stderr.write(`${level === "info" ? "" : level + ": "}${text}\n`);
  };
  // debug: the log file only (the Priors MCP server's own status lines, for instance)
  return { debug: (...a) => line("debug", a), info: (...a) => line("info", a), warn: (...a) => line("warn", a), error: (...a) => line("error", a) };
}
