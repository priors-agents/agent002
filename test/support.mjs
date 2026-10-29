// What the network-free service tests share (test/desk.test.mjs, test/recipes.test.mjs, test/stock-desk.test.mjs): three worker wallets, a
// facilitator stand-in that checks the buyer's real EIP-3009 signature, a buyer signing what a 402 asks, a chain
// stand-in JSON-RPC, and a desk on an in-memory store with the deterministic stub model.
import { ethers } from "ethers";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, toX402Signer } from "@priors/x402";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { makeDesk } from "../src/desk.mjs";
import { memoryStore } from "../src/store.mjs";
import { localRunner } from "../src/runner.mjs";
import { stubModel } from "../src/model.mjs";
import { settingsFromEnv } from "../src/settings.mjs";
import { PRIORS, TRANSFER_TOPIC } from "../src/chain.mjs";

export const W = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
export const env = (over = {}) => ({
  AGENT002_MODEL: "stub",
  AGENT002_WORKER_ADDRESS_1: W[0].address, AGENT002_WORKER_ADDRESS_2: W[1].address, AGENT002_WORKER_ADDRESS_3: W[2].address,
  AGENT002_WORKER_AGENT_ID_1: "9001",
  ...over,
});

/** A facilitator stand-in: checks the EIP-3009 signature, recipient and amount against the requirement it is given. */
export function fakeFacilitator() {
  const settled = [];
  const check = (payload, req) => {
    const a = payload.payload.authorization;
    const domain = { name: req.extra.name, version: req.extra.version, chainId: 4663, verifyingContract: req.asset };
    const signer = ethers.verifyTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, a, payload.payload.signature);
    if (signer.toLowerCase() !== a.from.toLowerCase()) return { isValid: false, invalidReason: "invalid_signature" };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: "recipient_mismatch" };
    if (String(a.value) !== String(req.amount)) return { isValid: false, invalidReason: "value_mismatch" };
    return { isValid: true, payer: a.from };
  };
  return {
    settled,
    async verify(payload, req) { return check(payload, req); },
    async settle(payload, req) {
      const v = check(payload, req);
      if (!v.isValid) return { success: false, errorReason: v.invalidReason };
      const tx = ethers.hexlify(ethers.randomBytes(32));
      settled.push({ to: req.payTo, amount: req.amount, from: v.payer, tx });
      return { success: true, transaction: tx, network: "eip155:4663", payer: v.payer };
    },
  };
}

/** A buyer signing what a 402 asks, the way an x402 client does (EIP-3009 on USDG's domain). */
export async function sign(buyer, req) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: buyer.address, to: req.payTo, value: req.amount, validAfter: String(now - 600), validBefore: String(now + req.maxTimeoutSeconds), nonce: ethers.hexlify(ethers.randomBytes(32)) };
  const s = toX402Signer(buyer);
  const signature = await s.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: 4663, verifyingContract: req.asset }, types: TRANSFER_WITH_AUTHORIZATION_TYPES, message: authorization });
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { authorization, signature } });
}

/** A chain stand-in: transactions by hash, a latest block that moves when told. */
export function fakeChain() {
  const txs = new Map();
  let latest = 1000;
  let time = Math.floor(Date.now() / 1000);
  const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  return {
    mine(n = 1) { latest += n; time += n; },
    /** A PRIORS (or other token) transfer, mined now. */
    transfer({ token = PRIORS.address, from, to, value, status = 1 }) {
      const hash = ethers.hexlify(ethers.randomBytes(32));
      txs.set(hash, { tx: { hash, from }, receipt: { status: `0x${status}`, blockNumber: ethers.toQuantity(latest + 1), logs: status ? [{ address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: ethers.toBeHex(value, 32) }] : [] }, time: time + 1 });
      latest += 1; time += 1;
      return hash;
    },
    async rpc(method, params) {
      if (method === "eth_blockNumber") return ethers.toQuantity(latest);
      if (method === "eth_getTransactionByHash") return txs.get(params[0])?.tx ?? null;
      if (method === "eth_getTransactionReceipt") return txs.get(params[0])?.receipt ?? null;
      if (method === "eth_getBlockByNumber") { const t = [...txs.values()].find((x) => x.receipt.blockNumber === params[0]); return t ? { timestamp: ethers.toQuantity(t.time) } : null; }
      if (method === "eth_call") return "0x" + "0".repeat(64);
      throw new Error(`unexpected ${method}`);
    },
  };
}

const noTools = () => ({ defs: async () => [], run: async () => ({ text: "", isError: true }) });

export function setup(over = {}, { modelFor = async () => stubModel(), facilitatorFor = null, toolbox = noTools, briefs = null, facilitator = fakeFacilitator() } = {}) {
  const settings = settingsFromEnv(env(over));
  const chain = fakeChain();
  const store = memoryStore();
  const desk = makeDesk({ settings, store, runner: localRunner({ settings, toolbox, modelFor }), facilitatorFor: facilitatorFor ? (w) => facilitatorFor(w, facilitator) : () => facilitator, rpc: chain.rpc, sandbox: false, briefs, modelFor });
  const call = (method, path, body, headers = {}) => desk.handle(new Request(`http://agent002.test${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { settings, facilitator, chain, store, desk, call };
}

export async function waitDone(call, id) {
  for (let i = 0; i < 200; i++) {
    const j = await (await call("GET", `/jobs/${id}`)).json();
    if (j.status === "done" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} did not finish`);
}
