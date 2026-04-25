// GET /v1/stats   — admin only (HTTP Basic).
//
// Aggregate counters from the persistence layer: total requests, sats
// earned, request distribution by endpoint, invoice + receipt totals.

import { trace, finalize } from "@/lib/log";
import { rateLimit } from "@/lib/ratelimit";
import { requireAdmin } from "@/lib/admin-auth";
import { aggregateStats } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = trace(req, "/v1/stats");

  const limited = rateLimit(req, ctx.request_id);
  if (limited) return finalize(ctx, limited);

  const denied = requireAdmin(req, ctx.request_id);
  if (denied) return finalize(ctx, denied);

  const stats = aggregateStats();
  const res = Response.json({
    schema: "lumen.stats.v1",
    served_at: new Date().toISOString(),
    ...stats,
  });
  return finalize(ctx, res);
}
