// Registering the workers' ERC-8004 identities, as agent001's join.mjs registers its own: each worker's key mints one
// identity to its own wallet in the ERC-8004 registry on Robinhood Chain (`register(string agentURI)`, the same call
// as `register(uri)` in the Priors SDK, github.com/priors-agents/priors, sdk/priors-v2.mjs). The agent URI is an
// inline registration file, so it needs no hosting. Once a worker has an identity, its Priors record has a page
// (priors.trade/agent?id=N), and what buyers pay it is income on that record.
//
// Each registration is a transaction from the worker's wallet, so each wallet needs a little ETH for gas. On a sandbox
// fork the sandbox gives them that.
import { ethers } from "ethers";
import { REGISTRY, SOURCE } from "./chain.mjs";
import { REGISTRY_ABI } from "./eth.mjs";

/** The registration file a worker's identity points at (ERC-8004 agentURI), inline as a data: URI. */
export function registrationUri(worker, publicUrl = null) {
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: `agent002 ${worker.id}`,
    description: `A worker of an agent002 fleet (${SOURCE}): its time is sold by the minute, paid in USDG over x402 or in PRIORS, into this wallet.`,
    services: [
      { name: "wallet", endpoint: `eip155:4663:${worker.address}` },
      ...(publicUrl ? [{ name: "agent002", endpoint: `${publicUrl.replace(/\/+$/, "")}/manifest` }] : []),
    ],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString("base64")}`;
}

/** Mint a new ERC-8004 identity to the signer; its id, read from the registry's mint log. */
export async function register(signer, uri) {
  const me = await signer.getAddress();
  const reg = new ethers.Contract(REGISTRY, REGISTRY_ABI, signer);
  const rc = await (await reg["register(string)"](uri)).wait();
  const T = ethers.id("Transfer(address,address,uint256)");
  const minted = rc.logs.filter((l) => l.address.toLowerCase() === REGISTRY.toLowerCase() && l.topics[0] === T && BigInt(l.topics[1]) === 0n && ethers.getAddress("0x" + l.topics[2].slice(26)) === me);
  if (minted.length !== 1) throw new Error(`expected one identity minted to ${me} in tx ${rc.hash}, found ${minted.length}`);
  return { agentId: Number(BigInt(minted[0].topics[3])), hash: rc.hash };
}

export async function ownerOf(provider, agentId) {
  return ethers.getAddress(await new ethers.Contract(REGISTRY, REGISTRY_ABI, provider).ownerOf(agentId));
}
