// Model spend: what the jobs may cost in model calls, per job and per UTC day for the whole deployment.
//
// The daily ledger counts what jobs spent and what running jobs may still spend: a job reserves its whole per-job cap
// when it is paid for, and gives back what it did not use when it finishes. So the day's spend can never pass the
// daily cap, even with every worker busy. A new job is quoted only when a whole per-job cap still fits in the day:
// when it does not, the service refuses the job before any payment is asked for (no 402, no quote).
//
// The ledger is a plain object, kept by the service's store:
//   { day: "2026-10-04", spentUsd: 0.0123, reserved: { "<jobId>": 0.05 } }
// Spend is counted on the UTC day a job finishes; a reservation made yesterday still counts until its job finishes.
import { usd8 } from "./money.mjs";

export class DailyCapReached extends Error {
  constructor(message) { super(message); this.name = "DailyCapReached"; this.code = "daily_cap"; this.status = 503; }
}

export const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

/** When the next UTC day starts, as an ISO string. */
export function nextUtcDay(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/** The ledger as of `now`: a new day starts with nothing spent, and keeps the reservations still open. */
export function rollLedger(ledger, now) {
  const day = utcDay(now);
  const l = ledger && typeof ledger === "object" ? ledger : {};
  if (l.day === day) return { day, spentUsd: Number(l.spentUsd) || 0, reserved: { ...(l.reserved || {}) } };
  return { day, spentUsd: 0, reserved: { ...(l.reserved || {}) } };
}

const sum = (o) => Object.values(o || {}).reduce((t, v) => t + Number(v || 0), 0);

/** What the day has left for new jobs: the cap, less what was spent and what running jobs may still spend. */
export function availableUsd(ledger, dailyCapUsd, now) {
  const l = rollLedger(ledger, now);
  return usd8(dailyCapUsd - l.spentUsd - sum(l.reserved));
}

/** Throws DailyCapReached unless a whole per-job cap still fits in the day. */
export function checkCanTakeJob(ledger, { dailyCapUsd, jobCapUsd }, now) {
  const left = availableUsd(ledger, dailyCapUsd, now);
  if (left + 1e-9 < jobCapUsd) {
    throw new DailyCapReached(`the daily model budget is spent ($${usd8(dailyCapUsd - left)} of $${dailyCapUsd} used or held by running jobs): no new jobs until ${nextUtcDay(now)}, nothing was charged`);
  }
  return left;
}

/** Hold `jobCapUsd` for `jobId`; returns the new ledger. Throws DailyCapReached when it does not fit. */
export function reserve(ledger, jobId, { dailyCapUsd, jobCapUsd }, now) {
  checkCanTakeJob(ledger, { dailyCapUsd, jobCapUsd }, now);
  const l = rollLedger(ledger, now);
  l.reserved[jobId] = jobCapUsd;
  return l;
}

/** The job finished having spent `spentUsd`: its reservation is released and its spend counted. */
export function settleJob(ledger, jobId, spentUsd, now) {
  const l = rollLedger(ledger, now);
  delete l.reserved[jobId];
  l.spentUsd = usd8(l.spentUsd + Math.max(0, Number(spentUsd) || 0));
  return l;
}
