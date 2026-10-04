// Paying in USDG over x402 v2 (scheme `exact` on eip155:4663): an EIP-3009 `transferWithAuthorization` the buyer signs
// and a facilitator settles. The HTTP side is done by hand here, with @x402/core's own header codecs, because the
// requirement is per request: the amount is minutes x rate and the payTo is the wallet of the worker the job was just
// assigned to. That is a quote, and its id travels in the requirement's `extra`, so the paid retry names the quote it
// pays and the service settles it against exactly the requirement it issued (never against what the client echoes).
//
//   unpaid  POST /jobs                       -> 402, header PAYMENT-REQUIRED (base64 JSON), the same JSON as the body
//   paid    POST /jobs + PAYMENT-SIGNATURE   -> facilitator verify, then settle, then 201 + PAYMENT-RESPONSE
//
// The Priors facilitator settles USDG only, and only for EOA payers (an EIP-3009 signature from a plain key): a buyer
// pays from an EOA.
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { NETWORK, USDG, sameAddress } from "./chain.mjs";

export const X402_VERSION = 2;

/** The x402 requirement for a USDG quote: exactly the quote's amount, to the assigned worker's wallet. */
export function requirementFor(quote, { maxTimeoutSeconds }) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDG.address,
    amount: String(quote.amount),
    payTo: quote.payTo,
    maxTimeoutSeconds,
    extra: { name: USDG.eip712.name, version: USDG.eip712.version, quote: quote.id },
  };
}

/** The 402 body (and, base64, the PAYMENT-REQUIRED header). */
export function paymentRequired({ requirement, url, description, error }) {
  return {
    x402Version: X402_VERSION,
    error,
    resource: { url, description, mimeType: "application/json" },
    accepts: [requirement],
  };
}

export const encodeRequired = (pr) => encodePaymentRequiredHeader(pr);
export const encodeSettlement = (s) => encodePaymentResponseHeader(s);

/**
 * The payment a request carries, or null when it carries none. x402 v2 sends it in PAYMENT-SIGNATURE; a v1 X-PAYMENT
 * header is refused with a clear message rather than ignored (it would otherwise look unpaid and get a fresh 402).
 */
export function readPayment(request) {
  const v2 = request.headers.get("payment-signature");
  if (!v2) {
    if (request.headers.get("x-payment")) throw Object.assign(new Error("x402 v1 (X-PAYMENT) is not accepted here: pay with x402 v2 (PAYMENT-SIGNATURE)"), { status: 400, code: "x402_v1" });
    return null;
  }
  let p;
  try { p = decodePaymentSignatureHeader(v2); } catch (_) { throw Object.assign(new Error("PAYMENT-SIGNATURE is not a base64 x402 payment payload"), { status: 400, code: "bad_payment" }); }
  if (!p || p.x402Version !== X402_VERSION || !p.accepted || typeof p.accepted !== "object" || !p.payload) {
    throw Object.assign(new Error("PAYMENT-SIGNATURE is not an x402 v2 payment payload"), { status: 400, code: "bad_payment" });
  }
  return p;
}

/** The quote id a payment names, from the requirement it accepted. */
export const quoteIdOf = (payload) => (typeof payload?.accepted?.extra?.quote === "string" ? payload.accepted.extra.quote : null);

/** Does the requirement the client accepted match the one issued, field for field? */
export function sameRequirement(accepted, req) {
  return !!accepted && accepted.scheme === req.scheme && accepted.network === req.network
    && sameAddress(accepted.asset, req.asset) && String(accepted.amount) === String(req.amount)
    && sameAddress(accepted.payTo, req.payTo) && accepted.extra?.quote === req.extra.quote;
}

/** The EIP-3009 authorization's nonce, which identifies one signed payment (for idempotent retries). */
export const authorizationNonce = (payload) => {
  const n = payload?.payload?.authorization?.nonce;
  return typeof n === "string" ? n.toLowerCase() : null;
};
