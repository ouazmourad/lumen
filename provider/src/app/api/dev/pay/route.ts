// MOCK MODE ONLY — local "faucet" that hands the buyer the preimage.

import { mockPreimageFor, wallet } from "@/lib/wallet";
import { errorResponse } from "@/lib/errors";
import { trace, finalize } from "@/lib/log";

export async function POST(req: Request) {
  const ctx = trace(req, "/api/dev/pay");
  if (wallet().kind !== "mock") {
    return finalize(ctx, errorResponse("not_found", "endpoint disabled (MOCK_MODE is off)", 404, ctx.request_id));
  }
  let body: { payment_hash?: string };
  try { body = await req.json(); }
  catch { return finalize(ctx, errorResponse("bad_request", "invalid JSON", undefined, ctx.request_id)); }
  if (!body.payment_hash)
    return finalize(ctx, errorResponse("bad_request", "payment_hash required", undefined, ctx.request_id));

  const preimage = mockPreimageFor(body.payment_hash);
  if (!preimage)
    return finalize(ctx, errorResponse("not_found", "no such invoice", undefined, ctx.request_id));

  return finalize(ctx, Response.json({ paid: true, preimage, note: "MOCK MODE — no actual sats moved" }));
}
