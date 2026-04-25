// Token-bucket rate limiter, per-IP, in-memory.
//   30 req/min sustained, burst of 5 over the steady rate.
//   Keys evicted lazily on hit when last-seen > 5 min.
//
// Returns null when allowed; a Response (429) when not.

import { errorResponse } from "./errors";

const RATE = 30;            // tokens per 60s window
const BURST = 35;           // 30 + 5 burst
const REFILL_PER_MS = RATE / 60_000;

type Bucket = { tokens: number; last: number };
const buckets = new Map<string, Bucket>();

function ipFrom(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  return real ?? "unknown";
}

export function rateLimit(req: Request, request_id: string, weight = 1): Response | null {
  const ip = ipFrom(req);
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: BURST, last: now };
    buckets.set(ip, b);
  } else {
    const refill = (now - b.last) * REFILL_PER_MS;
    b.tokens = Math.min(BURST, b.tokens + refill);
    b.last = now;
  }
  if (b.tokens < weight) {
    const need = weight - b.tokens;
    const retryMs = Math.ceil(need / REFILL_PER_MS);
    return errorResponse(
      "rate_limited",
      `${RATE} req/min sustained limit reached`,
      429,
      request_id,
      {
        "retry-after": String(Math.ceil(retryMs / 1000)),
        "x-ratelimit-limit": String(RATE),
        "x-ratelimit-remaining": "0",
      },
    );
  }
  b.tokens -= weight;

  // lazy eviction
  if (buckets.size > 5_000) {
    const cutoff = now - 5 * 60_000;
    for (const [k, v] of buckets) if (v.last < cutoff) buckets.delete(k);
  }

  return null;
}

export function ipOf(req: Request): string {
  return ipFrom(req);
}
