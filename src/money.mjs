// Prices. A worker's time is sold by the whole minute, at a rate per minute in each token; a job of N minutes costs
// exactly N times the rate, in the token's smallest unit (6 decimals for USDG, 18 for PRIORS). Amounts are bigints
// here and decimal strings in JSON; no floating point touches money.

export class BadRequest extends Error {
  constructor(message, code = "bad_request") { super(message); this.name = "BadRequest"; this.code = code; this.status = 400; }
}

/** "0.10" with 6 decimals -> 100000n. Refuses more decimals than the token has (that would be rounding money). */
export function toAtomic(value, decimals, what = "amount") {
  const s = typeof value === "number" ? plain(value) : String(value ?? "").trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${what} must be a decimal number like 0.10 (got ${JSON.stringify(String(value))})`);
  const frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length > decimals) throw new Error(`${what} ${s} has more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

function plain(n) {
  if (!Number.isFinite(n) || n < 0) throw new Error(`not an amount: ${n}`);
  return n.toFixed(18).replace(/\.?0+$/, "");
}

/** 100000n with 6 decimals -> "0.10": every significant digit, and at least two decimals. */
export function formatAtomic(units, decimals) {
  const u = BigInt(units);
  const neg = u < 0n;
  const a = neg ? -u : u;
  const base = 10n ** BigInt(decimals);
  let frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${a / base}.${frac}`;
}

/** The price of `minutes` at `rate` (atomic units per minute). */
export function priceFor(minutes, rate) {
  return BigInt(rate) * BigInt(minutes);
}

/** A whole number of minutes within the limits, or a 400. */
export function checkMinutes(value, { minMinutes, maxMinutes }) {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(n)) throw new BadRequest(`minutes must be a whole number from ${minMinutes} to ${maxMinutes}`, "bad_minutes");
  if (n < minMinutes || n > maxMinutes) throw new BadRequest(`minutes must be from ${minMinutes} to ${maxMinutes} (got ${n})`, "bad_minutes");
  return n;
}

export const MAX_TASK_CHARS = 4000;

/** The task text: a non-empty string, at most MAX_TASK_CHARS characters. */
export function checkTask(value) {
  if (typeof value !== "string" || !value.trim()) throw new BadRequest("task must be a non-empty string: what the worker should do", "bad_task");
  const t = value.trim();
  if (t.length > MAX_TASK_CHARS) throw new BadRequest(`task is ${t.length} characters; at most ${MAX_TASK_CHARS}`, "bad_task");
  return t;
}

/** Dollars kept to 8 decimals, so sums of model spend do not drift. */
export const usd8 = (x) => Math.round(Number(x) * 1e8) / 1e8;
