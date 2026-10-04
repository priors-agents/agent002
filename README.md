# agent002

A fleet of three worker agents that **sell their time by the minute** on Robinhood Chain, to other agents and to
people. Hire a worker for N minutes and give it a task; it works on it with a language model and read-only
[Priors](https://priors.trade) tools, and you get the result and a receipt.

- **Pay N x the rate**: in USDG over [x402](https://www.x402.org) (an EIP-3009 authorization the facilitator
  settles), or in PRIORS by an ordinary transfer, checked on chain. Default rate: 0.10 USDG or 25 PRIORS a minute.
- **Three workers, three wallets.** A job is assigned to a worker before it is priced, so the payment lands in the
  wallet of the worker that does the job. Each worker has its own ERC-8004 identity and a public Priors record.
- **Hard limits, in code**: a job ends when its minutes are up, a job's model spend has a cap ($0.05 by default),
  and so does the whole deployment's in a UTC day ($3). When the day's budget is spent, new jobs are refused before
  any payment is asked for.
- **Runs anywhere**: a Node server, or a Cloudflare Worker with Durable Objects. The same code.

It is the second open-source agent on Priors, after [agent001](https://github.com/priors-agents/agent001), whose
sandbox, facilitator and key handling it reuses: plain JavaScript (Node 20.18 or later), ethers v6, `@priors/x402`.

> **Real money, no audit.** On mainnet agent002 is paid real USDG and PRIORS. Nothing in Priors or here has had a
> third-party audit. Start in the sandbox, keep the rates and caps low, and give the workers' wallets nothing you
> cannot lose.

## Hire it

Everything starts at the manifest, `GET /manifest` (also `GET /`): the workers (id, ERC-8004 agent id, wallet,
Priors record link, jobs done), the rate per minute in USDG and in PRIORS, the payment methods, the minutes a job
may last (1 to 10), the model and its caps, and whether jobs are being taken right now.

```bash
curl -s https://<agent002 host>/manifest
```

### In USDG, over x402

`POST /jobs` with the minutes and the task. Unpaid, it answers **402**: its `PAYMENT-REQUIRED` header (base64 JSON;
the body carries the same requirement, plus a readable quote) asks for exactly minutes x rate USDG, `payTo` the
wallet of the worker the job was just assigned to.

```bash
curl -si -X POST https://<agent002 host>/jobs -H 'content-type: application/json' \
  -d '{"minutes": 2, "task": "Look up Priors agent 437 and summarize its record."}'
# HTTP/1.1 402 Payment Required
# payment-required: eyJ4NDAyVmVyc2lvbiI6Mi...
#   accepts[0]: scheme exact, network eip155:4663, asset USDG, amount 200000 (0.20 USDG = 2 x 0.10),
#               payTo 0x<the assigned worker's wallet>, extra.quote q_...
```

Paying means signing an EIP-3009 `transferWithAuthorization` for that amount and sending the same request again with
it in `PAYMENT-SIGNATURE`: any x402 v2 client does this. With [`@priors/x402`](https://www.npmjs.com/package/@priors/x402):

```js
import { createPayer } from "@priors/x402";
const payer = createPayer({ signer: wallet, maxPrice: 200_000n }); // an ethers Wallet on Robinhood Chain; never more than 0.20
const r = await payer.pay("https://<agent002 host>/jobs", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ minutes: 2, task: "Look up Priors agent 437 and summarize its record." }),
});
const job = await r.response.json(); // 201: { id: "job_...", status: "queued", worker, receipt: { txHash, ... } }
```

Or the example buyer in this repository, which reads the manifest, pays, waits and prints the receipt:

```bash
BUYER_KEY=0x... node examples/hire.mjs https://<agent002 host> --minutes 2 --task "..."
```

**Pay from an EOA** (a plain key). The Priors facilitator settles USDG only, by EIP-3009, and only for EOA payers:
a smart-contract wallet's signature is not settled.

### In PRIORS, by transfer

PRIORS has no permit and no EIP-3009, so there is nothing for a facilitator to settle: you transfer it yourself,
then claim the job with the transaction hash. First ask for a quote, which assigns the worker and tells you its
wallet:

```bash
curl -s -X POST https://<agent002 host>/quote -H 'content-type: application/json' \
  -d '{"minutes": 2, "payer": "0x<your EOA>"}'
# {"quote": "q_...", "payTo": "0x<worker wallet>", "amount": "50.00", "amountAtomic": "50000000000000000000",
#  "expiresAt": "...", "claimUntil": "...", "confirmations": 20, ...}

cast send 0xeDBf91223639800BCd5756815CAf908Df3b890bE "transfer(address,uint256)" 0x<worker wallet> 50000000000000000000 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --interactive

curl -s -X POST https://<agent002 host>/jobs -H 'content-type: application/json' \
  -d '{"minutes": 2, "task": "...", "quote": "q_...", "payment": {"token": "PRIORS", "txHash": "0x..."}}'
```

The claim is accepted only if the transaction, read from the chain: succeeded; moved PRIORS (a `Transfer` event
from the PRIORS contract, `0xeDBf91223639800BCd5756815CAf908Df3b890bE`); sent at least the quoted amount to the
quoted worker's wallet; was sent by the payer the quote names; was mined after the quote was issued and before it
expired (30 minutes); has enough confirmations (20, about 2 seconds); and has never paid for a job before. Not yet
confirmed is `409` with `"retry": true` (try again in a few seconds); every other refusal is final and says why.
`examples/hire.mjs --pay priors` does all three steps.

### The job and its receipt

```bash
curl -s https://<agent002 host>/jobs/job_...
```

```json
{
  "id": "job_...", "status": "done", "minutes": 2, "task": "...",
  "worker": { "id": "w2", "agentId": 7635, "wallet": "0x..." },
  "result": "Agent #437 has repaid 3 loans totaling 15.00 USDG ...",
  "receipt": {
    "payer": "0x...", "amount": "0.20", "token": "USDG", "method": "x402", "txHash": "0x...",
    "worker": "0x...", "workerId": "w2", "agentId": 7635,
    "paidAt": "...", "startedAt": "...", "finishedAt": "...", "minutesBought": 2, "minutesUsed": 0.09,
    "modelSpendUsd": 0.00031453, "model": "openai/gpt-6-luna", "steps": 2, "toolCalls": 2, "stoppedBy": null
  }
}
```

`status` goes `queued`, `running`, then `done` (or `failed`, with `error`). `stoppedBy` is `time` or `budget` when a
limit ended the job before a final answer. The job id is 128 random bits: whoever holds it can read the job.

| refusal | HTTP | `code` |
|---|---|---|
| the day's model budget is spent (no 402, no quote) | 503 | `daily_cap` |
| USDG is not set up (no worker has a facilitator API key; no 402) | 503 | `usdg_unavailable` |
| bad minutes, empty or long task, not JSON | 400 | `bad_minutes`, `bad_task`, `bad_json` |
| an x402 payment that does not match its quote | 402 / 400 | `requirement_mismatch`, `quote_mismatch` |
| a quote already paid for | 409 | `quote_used` |
| PRIORS: hash already used | 409 | `reused` |
| PRIORS: amount below the price | 402 | `short_amount` |
| PRIORS: to another wallet than the quote's worker | 402 | `wrong_recipient` |
| PRIORS: no PRIORS moved (another token) | 402 | `wrong_token` |
| PRIORS: the transaction reverted | 402 | `failed_tx` |
| PRIORS: sent by another address than the quote's payer | 402 | `wrong_payer` |
| PRIORS: mined before the quote, or after it expired | 402 | `before_quote`, `quote_expired` |
| PRIORS: not mined yet, or too few confirmations | 409 | `not_mined`, `confirmations` (`retry: true`) |

## The fleet

Three workers, `w1` to `w3`, each with its own key and wallet, share one queue. A new job goes to the least-loaded
worker (fewest jobs queued or running); among equally loaded ones it goes round the fleet. The assignment is made
before the price is quoted, because the quote names who gets paid: the 402's `payTo`, or the PRIORS quote's
`payTo`. Each worker runs its own jobs one at a time; a job paid to `w2` is done by `w2`.

`agent002 join` registers an ERC-8004 identity for each worker (one transaction each, from the worker's own wallet),
so each has a Priors record: `https://priors.trade/agent?id=<id>`, linked from the manifest (before a worker has an
identity, the link goes by its wallet). What buyers pay a worker is income on that record.

A job runs an agent loop: the model gets the task and these tools, all read-only, with no key:

- `priors_check`: the free [check API](https://priors.trade/api/check), an agent's record by id or address;
- `agent_record`, `score_of`, `pool_stats`, `stock_assets`, `stock_position`, `recent_activity`, `find_services`,
  `facilitator_info`: the hosted, read-only [Priors MCP server](https://mcp.priors.trade/mcp);
- `time_left`: the job's own clock and budget.

The model comes from [OpenRouter](https://openrouter.ai) (`OPENROUTER_API_KEY`; default `openai/gpt-6-luna`, any
OpenRouter model with tools works). `AGENT002_MODEL=stub` selects a deterministic stub with no model and no key,
for tests.

## The limits

- **Wall clock**: a job ends by its deadline, the start plus the minutes bought. Every model and tool call carries
  that deadline; near the end the model is asked to answer from what it has.
- **Model spend per job** (`AGENT002_JOB_SPEND_CAP_USD`, default 0.05): before each call, its worst case is priced
  from OpenRouter's prices for the model (the highest any provider charges) and `max_tokens` is cut to fit what the
  job has left. When not even a short reply fits, the job stops.
- **Model spend per UTC day** (`AGENT002_DAILY_SPEND_CAP_USD`, default 3): a paid job reserves its whole per-job cap
  and gives back what it did not use. New jobs are taken only while a whole per-job cap still fits in the day; when
  it does not, `POST /jobs` and `POST /quote` answer `503` with the time the day starts over, and no 402 is issued, so
  nobody pays for a job that cannot run. A paid x402 request that no longer fits is refused before it is settled.
  A valid PRIORS payment refused for this reason is not marked used: claim it again after midnight UTC (within 48
  hours of the quote).

## Run your own

You need [Node.js](https://nodejs.org) 20.18 or later (22 or later for wrangler), git, and for the sandbox `anvil`
from [Foundry](https://getfoundry.sh).

```bash
git clone https://github.com/priors-agents/agent002 && cd agent002
npm install
alias agent002="node $PWD/bin/agent002.mjs"
agent002 init          # three worker wallets; the keys stay in .agent002/workers.json (owner-only), never printed
```

agent002 is not published on npm: the alias runs this clone's own CLI (in a script, call `node bin/agent002.mjs`).
Run the commands from the clone's folder: agent002 keeps its files in `./.agent002` (`AGENT002_HOME` moves it).

### The sandbox (play money)

A local fork of Robinhood Chain with the real contracts, as in agent001: anvil reads the chain as it goes (so it
needs internet), every transaction stays on the fork, and the fork mines a block every second. In a second
terminal, leave it running:

```bash
agent002 sandbox       # 127.0.0.1:8545; the workers get gas; a fork-only facilitator settles x402 on the fork
```

Then:

```bash
agent002 join                                      # three ERC-8004 identities, on the fork
AGENT002_MODEL=stub agent002 serve                 # 127.0.0.1:4022 (or OPENROUTER_API_KEY for a real model)
```

And as a buyer, from a third terminal (any EOA key; this one exists only for the fork):

```bash
export BUYER_KEY=$(node -e 'console.log(require("ethers").Wallet.createRandom().privateKey)')
agent002 fund $(node -e 'console.log(new (require("ethers").Wallet)(process.env.BUYER_KEY).address)')   # play USDG and PRIORS
node examples/hire.mjs http://127.0.0.1:4022 --minutes 2 --task "Say hello." --rpc http://127.0.0.1:8545
node examples/hire.mjs http://127.0.0.1:4022 --minutes 1 --task "Say hello." --rpc http://127.0.0.1:8545 --pay priors
agent002 status                                    # each worker's balances and jobs done
```

`--fork-url` (or `AGENT002_FORK_URL`) forks another node than the public RPC; its URL is never printed. A stopped
sandbox makes the commands refuse until you start a new one or delete `.agent002/sandbox.json`: never a silent
switch to mainnet.

### On mainnet, with Node

Send each worker wallet a little ETH on Robinhood Chain for gas (0.0005 ETH is plenty), then:

```bash
agent002 join                                         # registers the three identities (three transactions)
agent002 merchant register --url https://<public URL> # each worker signs the Priors facilitator's challenge (no gas)
OPENROUTER_API_KEY=... agent002 serve --host 0.0.0.0
```

The service needs a public https address (a server, or a tunnel such as `cloudflared tunnel --url
http://127.0.0.1:4022`). `merchant register` gives each worker its own API key with the facilitator, kept in
`.agent002/merchant.json`; `serve` settles each worker's payments with its own key. Payments go straight to the
worker wallets; to move what they earned, use the worker keys from `.agent002/workers.json` with any wallet.

### As a Cloudflare Worker

[`wrangler.jsonc`](wrangler.jsonc) deploys [`src/worker.mjs`](src/worker.mjs): a `Desk` Durable Object keeps the
quotes, jobs, queue, used PRIORS transactions and the day's spend; each paid job runs in its own `JobRunner` Durable
Object, in an alarm (15 minutes of wall time, so `AGENT002_MAX_MINUTES` is at most 14 there). The Worker needs no
worker key: it only receives payments.

```bash
agent002 wrangler-secrets            # writes .agent002/wrangler-secrets.json (owner-only) and prints the vars below
# put the printed AGENT002_WORKER_ADDRESS_<n> / AGENT002_WORKER_AGENT_ID_<n> in wrangler.jsonc "vars", then:
npx wrangler secret bulk .agent002/wrangler-secrets.json && rm .agent002/wrangler-secrets.json
npx wrangler secret put OPENROUTER_API_KEY    # if it was not in that file
npx wrangler deploy
```

Secrets (never in a file you commit): `OPENROUTER_API_KEY`; `AGENT002_FACILITATOR_KEY_1`, `_2`, `_3` (each worker's
facilitator API key; a worker without one takes PRIORS jobs only); optionally `AGENT002_RPC` (a private Robinhood
Chain node). `AGENT002_WORKER_KEY_<n>` is accepted instead of an address, but the Worker has no use for a key.
`npx wrangler deploy --dry-run --outdir dist-worker` (or `npm run worker:dry-run`) builds it without deploying.

The Worker runs locally against the sandbox too: the sandbox's facilitator also answers over HTTP on its port + 2.

```bash
npx wrangler dev --var AGENT002_MODEL:stub --var AGENT002_RPC:http://127.0.0.1:8545 \
  --var AGENT002_FACILITATOR_URL:http://127.0.0.1:8547 --var AGENT002_PRIORS_CONFIRMATIONS:3 \
  --var AGENT002_WORKER_ADDRESS_1:0x... --var AGENT002_FACILITATOR_KEY_1:sandbox-fork-only ...   # and for 2, 3
```

## Configuration

All from the environment, the same names in Node and in the Worker (`vars` and secrets there).

| variable | default | |
|---|---|---|
| `AGENT002_RATE_USDG` | 0.10 | USDG per minute |
| `AGENT002_RATE_PRIORS` | 25 | PRIORS per minute (a fixed rate you set; no price oracle) |
| `AGENT002_MIN_MINUTES`, `AGENT002_MAX_MINUTES` | 1, 10 | a job's length, whole minutes (at most 14 in a Worker) |
| `AGENT002_MODEL` | openai/gpt-6-luna | an OpenRouter model with tools, or `stub` |
| `AGENT002_MODEL_PRICE` | none | `in,out` USD per million tokens, instead of OpenRouter's price list |
| `AGENT002_JOB_SPEND_CAP_USD` | 0.05 | most one job may spend on the model |
| `AGENT002_DAILY_SPEND_CAP_USD` | 3 | most all jobs may spend on the model in a UTC day |
| `AGENT002_PRIORS_CONFIRMATIONS` | 20 (3 in the sandbox) | blocks a PRIORS payment needs |
| `AGENT002_PRIORS_QUOTE_SECONDS` | 1800 | how long after its quote a PRIORS transfer counts |
| `AGENT002_WORKER_CONCURRENCY` | 1 | jobs one worker runs at a time |
| `AGENT002_RPC` | the public RPC | Robinhood Chain JSON-RPC (a private URL is never printed) |
| `AGENT002_FACILITATOR_URL` | https://facilitator.priors.trade | the x402 facilitator |
| `AGENT002_OPENROUTER_URL` | https://openrouter.ai/api/v1 | the model endpoint (OpenRouter's API, or one compatible with it) |
| `AGENT002_PUBLIC_URL` | each request's own URL | the service's public URL, for the 402's resource and the manifest |
| `AGENT002_WORKER_ADDRESS_<n>` or `AGENT002_WORKER_KEY_<n>` | `.agent002/workers.json` | worker n's wallet (n = 1, 2, 3) |
| `AGENT002_WORKER_AGENT_ID_<n>` | from `agent002 join` | worker n's ERC-8004 id |
| `AGENT002_FACILITATOR_KEY_<n>` | `.agent002/merchant.json` | secret: worker n's facilitator API key |
| `OPENROUTER_API_KEY` | none | secret: the model provider's key |

## Security

- **Keys.** `agent002 init` makes the worker keys and keeps them in `.agent002/workers.json` (owner-only; a file
  others can read is refused); `AGENT002_WORKER_KEY_<n>` can supply them instead. They are never printed, and a
  key-shaped argument is refused. A key signs only a worker's identity registration and its facilitator
  registration (the facilitator's challenge is checked against its exact text first); serving jobs needs only addresses, and the Worker holds
  no key at all. Every line agent002 writes (terminal, log, job results, errors) is redacted for every key, the
  OpenRouter key, the facilitator keys and a private RPC URL; the fork tests check that none appears.
- **A payment pays for one job.** An x402 payment is settled only against the requirement its quote issued (amount,
  asset, network, worker), and the same signed payment sent twice returns the same job. A PRIORS transaction pays
  once, ever (the used hashes are kept), and only for the quote it fits.
- **A transaction hash is public**: anyone can see a PRIORS transfer to a worker and try to claim it. That is why a
  PRIORS quote names its payer, and why the transfer must be sent by that payer and mined after the quote was
  issued. Someone who knew your address and your worker, and asked for a quote naming you before you transferred,
  could still race your claim: claim as soon as your transfer is confirmed.
- **The workers cannot move money.** Their tools are read-only views of Priors, with no key. A task is untrusted
  input and tool results are marked as data, but nothing a task or a tool result says can make a worker pay, sign or
  send anything. The model spend caps hold in code, before each call.
- **The sandbox is only a sandbox**: it writes balances and settles only on a node that says it is anvil, and a
  stopped sandbox is an error, not a switch to mainnet.
- On the fork the workers' tools still read Priors on mainnet (the hosted MCP server and the check API).

## How it is built

```
bin/agent002.mjs          the CLI (src/cli.mjs has the commands)
src/desk.mjs              the service: manifest, quotes, x402 and PRIORS payments, the queue, receipts (Node and Worker)
src/fleet.mjs             assigning a job to a worker
src/money.mjs             prices: minutes x rate, in each token's smallest unit
src/x402.mjs              the 402 and the payment headers (@x402/core's codecs)
src/priors-pay.mjs        the PRIORS payment rules, and reading a transaction from the chain
src/budget.mjs            the daily model budget
src/agent.mjs             a job's agent loop, with its wall-clock and spend limits
src/model.mjs             OpenRouter (priced before each call) and the stub
src/tools.mjs             the read-only Priors tools (check API, hosted MCP)
src/settings.mjs          the environment
src/store.mjs             the state interface; src/file-store.mjs (Node); Durable Object storage (Worker)
src/worker.mjs            the Cloudflare Worker: Desk and JobRunner Durable Objects
src/server.mjs            the Node HTTP server; src/runner.mjs runs jobs in process
src/sandbox.mjs           the local fork; src/facilitator-local.mjs settles x402 on it
src/join.mjs              ERC-8004 registration; src/merchant.mjs the facilitator registration
src/workers.mjs           the worker keys (Node); src/secrets.mjs redaction
examples/hire.mjs         a buyer: pays in USDG over x402 or in PRIORS, waits, prints the receipt
```

## Tests

```bash
npm test             # network-free: prices, assignment, the PRIORS rules (reused hash, short amount, wrong recipient,
                     # wrong token, failed tx...), the daily cap, receipts, the spend and time limits, the tools
npm run test:fork    # the whole flow on a local fork through the CLI (needs anvil): a USDG hire over x402 with its
                     # receipt, PRIORS payments and their refusals, and jobs spread over the three workers with each
                     # wallet up by exactly its jobs' prices; FORK_URL forks another node than the public RPC
npm run safety       # no key, token, private RPC host or .env in the tracked files or the git history
```

The fork tests run on the stub model; with `AGENT002_MODEL=<an OpenRouter model>` and `OPENROUTER_API_KEY` set,
the USDG test runs on that model instead.

## License

MIT.
