// Robinhood Chain (4663) and the two tokens agent002 is paid in. This file runs in Node and in a Cloudflare Worker,
// so it holds plain constants and no dependency.
//
// The addresses come from the Priors deployment record, deployments/4663.v2.json in
// https://github.com/priors-agents/priors (fields `usdg`, `priors` and `registry`); test/unit.test.mjs checks USDG and
// the registry against @priors/x402's own constants, and the fork tests read PRIORS's symbol and decimals on chain.
export const CHAIN_ID = 4663;
export const NETWORK = "eip155:4663"; // as x402 v2 names it (CAIP-2)
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** USDG (Global Dollar): 6 decimals, EIP-3009 `transferWithAuthorization` on the EIP-712 domain "Global Dollar" / "1". */
export const USDG = Object.freeze({
  symbol: "USDG",
  address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  decimals: 6,
  eip712: Object.freeze({ name: "Global Dollar", version: "1" }),
});

/** $PRIORS: a plain ERC-20 with 18 decimals, no permit and no EIP-3009, so it is paid by an ordinary transfer. */
export const PRIORS = Object.freeze({
  symbol: "PRIORS",
  address: "0xeDBf91223639800BCd5756815CAf908Df3b890bE",
  decimals: 18,
});

export const TOKENS = Object.freeze({ USDG, PRIORS });

/** The ERC-8004 identity registry the workers register in. */
export const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

export const SITE = "https://priors.trade";
export const SOURCE = "https://github.com/priors-agents/agent002";

/** keccak256("Transfer(address,address,uint256)"), the ERC-20 Transfer event's topic 0. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * A worker's public Priors record on priors.trade: its agent page by id once it has an ERC-8004 identity, by its
 * wallet before that. In the sandbox the identity exists only on the fork, so the link goes by wallet (an id would
 * open whichever mainnet agent has that number).
 */
export function recordLink({ agentId = null, wallet, sandbox = false }) {
  if (agentId !== null && agentId !== undefined && !sandbox) return `${SITE}/agent?id=${agentId}`;
  return `${SITE}/agent?owner=${wallet}`;
}

export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const sameAddress = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
export const isTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
