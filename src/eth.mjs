// ethers helpers for the Node commands: a provider for Robinhood Chain, the sandbox test, and the few ABIs the
// commands call (token balances and transfers, the ERC-8004 registry).
import { ethers } from "ethers";
import { CHAIN_ID } from "./chain.mjs";

export function makeProvider(rpc) {
  const p = new ethers.JsonRpcProvider(rpc, ethers.Network.from(CHAIN_ID), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  p.pollingInterval = 500; // sub-second blocks
  return p;
}

/** True on a local anvil fork (agent002 sandbox), where fork-only shortcuts are allowed. */
export async function isSandbox(provider) {
  try { return /^anvil\//i.test(String(await provider.send("web3_clientVersion", []))); } catch (_) { return false; }
}

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export const REGISTRY_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function register(string) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];
