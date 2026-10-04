// The sandbox: a local fork of Robinhood Chain (anvil, from Foundry) where the whole flow runs with play money, as in
// agent001. Nothing here can touch mainnet: anvil forks the chain lazily and every write stays on the local node. On
// the fork only:
//   - each worker's wallet gets 1 ETH for gas (to register its identity with `agent002 join`);
//   - a fork-only facilitator wallet settles the x402 USDG payments (src/facilitator-local.mjs), paying the gas;
//   - `agent002 fund <address>` gives a buyer ETH, USDG and PRIORS (written into the tokens' storage).
// The fork mines a block every second as well as on each transaction (anvil --block-time 1 --mixed-mining), so a
// PRIORS payment gathers confirmations as it would on the chain, and the fork's clock keeps up with the wall clock
// (an x402 authorization is signed against the buyer's clock).
import { spawn } from "node:child_process";
import { ethers } from "ethers";
import { USDG, PRIORS } from "./chain.mjs";
import { ERC20_ABI, makeProvider, isSandbox } from "./eth.mjs";
import { pathOf, writeJson } from "./home.mjs";

async function waitRpc(url, ms = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) });
      const j = await r.json();
      if (/^anvil\//i.test(String(j.result))) return;
      throw new Error(`something other than anvil answers on ${url} (${String(j.result).slice(0, 40)}): refusing to use it as a sandbox`);
    } catch (e) {
      if (/refusing/.test(e.message)) throw e;
      if (Date.now() - t0 > ms) throw new Error(`anvil did not come up on ${url} in time (is Foundry installed? https://getfoundry.sh)`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/**
 * Start anvil on a fork of `forkUrl`. { rpc, provider, stop }. Refuses a port where something else already answers.
 * The fork URL may be a private node's (a key in it): it goes to anvil's arguments only, never to any output.
 */
export async function startFork({ port = 8545, forkUrl, log = () => {} }) {
  const rpc = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(1500) });
    if (r) throw new Error(`port ${port} is already in use: stop what runs there, or pick another with --port`);
  } catch (e) { if (/already in use/.test(e.message)) throw e; }
  log(`starting a fork of Robinhood Chain on ${rpc} (anvil)...`);
  const child = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--chain-id", "4663", "--block-time", "1", "--mixed-mining", "--silent"], { stdio: "ignore" });
  let spawnError = null;
  child.on("error", (e) => { spawnError = e; });
  const stop = () => { try { child.kill("SIGTERM"); } catch (_) { /* gone */ } };
  try {
    await waitRpc(rpc);
  } catch (e) {
    stop();
    if (spawnError?.code === "ENOENT") throw new Error("anvil is not installed: install Foundry (https://getfoundry.sh), then run `foundryup`");
    throw e;
  }
  return { rpc, provider: makeProvider(rpc), stop, child };
}

/** Write `amount` into `holder`'s balance of `token` by finding the balance mapping's storage slot. Fork only. */
export async function dealErc20(provider, token, holder, amount) {
  const t = new ethers.Contract(token, ERC20_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const bases = [...Array(40).keys()].map((i) => coder.encode(["uint256"], [i]))
    .concat(["0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"]); // OpenZeppelin ERC20Upgradeable (ERC-7201)
  const want = ethers.toBeHex(amount, 32);
  for (const base of bases) {
    const slot = ethers.keccak256(coder.encode(["address", "bytes32"], [holder, base]));
    const before = await provider.send("eth_getStorageAt", [token, slot, "latest"]);
    await provider.send("anvil_setStorageAt", [token, slot, want]);
    if ((await t.balanceOf(holder)) === amount) return;
    await provider.send("anvil_setStorageAt", [token, slot, before]);
  }
  throw new Error(`could not find the balance slot of ${token}`);
}

/** Give the workers gas and name a fork-only facilitator. Writes sandbox.json. */
export async function setUpSandbox(provider, { home, rpc, workers }) {
  if (!(await isSandbox(provider))) throw new Error("not a sandbox fork: refusing to write balances");
  const facilitator = ethers.Wallet.createRandom(); // settles x402 USDG payments on the fork, paying the gas
  await provider.send("anvil_setBalance", [facilitator.address, ethers.toBeHex(ethers.parseEther("10"))]);
  for (const w of workers) await provider.send("anvil_setBalance", [w.address, ethers.toBeHex(ethers.parseEther("1"))]);
  writeJson(pathOf(home, "sandbox.json"), { rpc, facilitatorKey: facilitator.privateKey, agentIds: {}, note: "fork-only key and ids: worthless anywhere but this local fork", startedAt: new Date().toISOString() });
  return { facilitator: facilitator.address };
}

/** Play money for `address` on the fork: ETH for gas, USDG and PRIORS. */
export async function fund(provider, address, { eth = 1, usdg = 20, priors = 1000 } = {}) {
  if (!(await isSandbox(provider))) throw new Error("fund only works on a sandbox fork");
  await provider.send("anvil_setBalance", [address, ethers.toBeHex(ethers.parseEther(String(eth)))]);
  await dealErc20(provider, USDG.address, address, ethers.parseUnits(String(usdg), USDG.decimals));
  await dealErc20(provider, PRIORS.address, address, ethers.parseUnits(String(priors), PRIORS.decimals));
}
