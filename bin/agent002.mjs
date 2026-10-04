#!/usr/bin/env node
// agent002: three worker agents that sell their time by the minute on Robinhood Chain.
// `agent002 help` lists the commands. A key is never taken on the command line and never printed.
import { guardProcessOutput, safeMessage } from "../src/secrets.mjs";
import { commands, usage } from "../src/cli.mjs";

guardProcessOutput();
const [name = "help", ...rest] = process.argv.slice(2);
// exactly 64 hex digits standing alone is a private key's shape
if (rest.some((a) => /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}($|[^0-9a-fA-F])/.test(a))) {
  process.stderr.write("agent002: that looks like a private key on the command line: refused. agent002 keeps worker keys in .agent002/workers.json (or AGENT002_WORKER_KEY_<n>); never pass one as an argument.\n");
  process.exit(2);
}
const cmd = Object.hasOwn(commands, name) ? commands[name] : null;
if (!cmd) { process.stderr.write(usage()); process.exit(name === "help" || name === "--help" || name === "-h" ? 0 : 2); }
try {
  const code = await cmd(rest);
  process.exit(code ?? 0);
} catch (e) {
  process.stderr.write(`agent002 ${name}: ${safeMessage(e, 1000)}\n`);
  process.exit(e?.exitCode ?? 1);
}
