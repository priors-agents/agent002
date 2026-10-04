// Paying in PRIORS. $PRIORS has no permit and no EIP-3009, so there is no signed authorization for a facilitator to
// settle: the buyer sends an ordinary ERC-20 transfer, then tells the service its transaction hash. The service reads
// that transaction from the chain and accepts it only if all of this holds:
//
//   - it was mined and did not revert;
//   - it moved PRIORS (a Transfer event emitted by the PRIORS contract itself, not some other token);
//   - the PRIORS went to the wallet of the worker the quote assigned (the sum of the transfers to it in that tx);
//   - it was sent by the payer the quote names (the transaction's own sender, so a buyer pays from an EOA);
//   - it is at least the quote's price;
//   - it was mined after the quote was issued and before the quote expired (a transfer made for something else, or
//     one somebody saw on chain and tries to claim with a fresh quote, does not fit the window);
//   - it has enough confirmations (otherwise: not yet, try again);
//   - its hash has never paid for a job before (the service keeps every used hash, forever).
//
// judgePriorsTransfer() is the rules, a pure function; readPriorsTransfer() reads what they need from a JSON-RPC node.
import { TRANSFER_TOPIC, sameAddress, isTxHash } from "./chain.mjs";
import { hexToNumber } from "./rpc.mjs";
import { formatAtomic } from "./money.mjs";

export class PaymentRefused extends Error {
  /** `retry`: the payment may still become acceptable (not mined yet, not enough confirmations). */
  constructor(code, message, { status = 402, retry = false } = {}) {
    super(message);
    this.name = "PaymentRefused";
    this.code = code;
    this.status = status;
    this.retry = retry;
  }
}

const topicAddress = (t) => (typeof t === "string" && t.length === 66 ? "0x" + t.slice(26) : null);

/** Every ERC-20 Transfer event in a receipt: { token, from, to, value }. */
export function transfersIn(receipt) {
  const out = [];
  for (const l of receipt?.logs || []) {
    if (l.removed) continue;
    if (!Array.isArray(l.topics) || l.topics.length !== 3 || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    let value;
    try { value = BigInt(l.data); } catch (_) { continue; }
    out.push({ token: l.address, from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), value });
  }
  return out;
}

/**
 * Decide whether a transaction pays for a quote. Throws PaymentRefused (with a code a test or a client can act on),
 * or returns { payer, amount, blockNumber, blockTime, confirmations }.
 *
 * @param {object} o
 * @param {object|null} o.tx           eth_getTransactionByHash result
 * @param {object|null} o.receipt      eth_getTransactionReceipt result
 * @param {number} o.latestBlock       the chain's latest block number
 * @param {number|null} o.blockTime    the timestamp (seconds) of the receipt's block
 * @param {{ address: string, decimals: number, symbol: string }} o.token   PRIORS
 * @param {string} o.payTo             the assigned worker's wallet
 * @param {string|null} o.payer        the payer the quote names (null: anyone)
 * @param {bigint} o.minAmount         the price, in the token's smallest unit
 * @param {number} o.minConfirmations
 * @param {number|null} o.notBefore    seconds: the quote's issue time (the transfer must be mined at or after it)
 * @param {number|null} o.notAfter     seconds: the quote's expiry (the transfer must be mined by then)
 */
export function judgePriorsTransfer({ tx, receipt, latestBlock, blockTime, token, payTo, payer = null, minAmount, minConfirmations, notBefore = null, notAfter = null }) {
  if (!receipt || !tx) throw new PaymentRefused("not_mined", "the transaction is not mined yet (or not on Robinhood Chain): try again in a few seconds", { status: 409, retry: true });
  if (hexToNumber(receipt.status) !== 1) throw new PaymentRefused("failed_tx", "the transaction reverted: it moved nothing, so it pays for nothing");

  const all = transfersIn(receipt);
  const ofToken = all.filter((t) => sameAddress(t.token, token.address));
  if (!ofToken.length) {
    const other = all.length ? ` (it moved ${[...new Set(all.map((t) => t.token))].join(", ")} instead)` : "";
    throw new PaymentRefused("wrong_token", `the transaction moved no ${token.symbol}${other}: pay with ${token.symbol} (${token.address})`);
  }
  const toWorker = ofToken.filter((t) => sameAddress(t.to, payTo));
  if (!toWorker.length) {
    throw new PaymentRefused("wrong_recipient", `the transaction sent ${token.symbol} to ${[...new Set(ofToken.map((t) => t.to))].join(", ")}, not to ${payTo}, the wallet of the worker this quote assigned`);
  }
  if (payer && !sameAddress(tx.from, payer)) {
    throw new PaymentRefused("wrong_payer", `the transaction was sent by ${tx.from}, not by ${payer}, the payer this quote names`);
  }
  const amount = toWorker.reduce((s, t) => s + t.value, 0n);
  if (amount < BigInt(minAmount)) {
    throw new PaymentRefused("short_amount", `the transaction paid ${formatAtomic(amount, token.decimals)} ${token.symbol}; the price is ${formatAtomic(minAmount, token.decimals)} ${token.symbol}`);
  }
  if (notBefore !== null && blockTime !== null && blockTime < notBefore) {
    throw new PaymentRefused("before_quote", `the transaction was mined at ${iso(blockTime)}, before this quote was issued (${iso(notBefore)}): a payment counts only for a quote asked before it`);
  }
  if (notAfter !== null && blockTime !== null && blockTime > notAfter) {
    throw new PaymentRefused("quote_expired", `the transaction was mined at ${iso(blockTime)}, after this quote expired (${iso(notAfter)})`);
  }
  const blockNumber = hexToNumber(receipt.blockNumber);
  const confirmations = latestBlock - blockNumber + 1;
  if (confirmations < minConfirmations) {
    throw new PaymentRefused("confirmations", `the transaction has ${confirmations} confirmation(s); ${minConfirmations} are needed: try again in a few seconds`, { status: 409, retry: true });
  }
  return { payer: tx.from, amount, blockNumber, blockTime, confirmations };
}

const iso = (s) => new Date(s * 1000).toISOString();

/** What judgePriorsTransfer needs, read from the chain. */
export async function readPriorsTransfer(rpc, txHash) {
  if (!isTxHash(txHash)) throw new PaymentRefused("bad_tx_hash", "payment.txHash must be a transaction hash (0x and 64 hex digits)", { status: 400 });
  const [tx, receipt, latest] = await Promise.all([
    rpc("eth_getTransactionByHash", [txHash]),
    rpc("eth_getTransactionReceipt", [txHash]),
    rpc("eth_blockNumber", []),
  ]);
  let blockTime = null;
  if (receipt?.blockNumber) {
    const b = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    blockTime = b ? hexToNumber(b.timestamp) : null;
  }
  return { tx, receipt, latestBlock: hexToNumber(latest), blockTime };
}
