// GET /v1/receipts/{id}
//
// Replayable fetch of a receipt the buyer already paid for. Free to call
// (the buyer paid 120 sat for the original mint — they shouldn't pay
// again to read it back). Cached aggressively so a directory or audit
// tool can fetch repeatedly without hitting our DB hard.
//
// Returns the full claims envelope + signature so the holder can verify
// it themselves: HMAC-SHA-256 of claims_json under L402_SECRET == signature.

import { errorResponse } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { trace, finalize } from "@/lib/log";
import { getReceipt } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = trace(req, `/v1/receipts/${id.slice(0, 12)}…`);

  const limited = rateLimit(req, ctx.request_id);
  if (limited) return finalize(ctx, limited);

  const row = getReceipt(id);
  if (!row) return finalize(ctx, errorResponse("not_found", "no such receipt", undefined, ctx.request_id));

  const claims = JSON.parse(row.claims_json);
  const res = Response.json({ ...claims, signature: row.signature, served_at: new Date().toISOString() }, {
    headers: { "cache-control": "public, max-age=300, immutable" },
  });
  return finalize(ctx, res);
}
