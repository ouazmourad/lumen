// MOCK MODE ONLY.
//
// Lets the buyer "pay" an invoice without a wallet by handing back the
// preimage for a given payment_hash. Disabled when MOCK_MODE != "true".
//
// This is the equivalent of running a regtest faucet locally — useful
// for end-to-end testing before you wire up Alby.

import { mockPreimageFor, wallet } from "@/lib/wallet";

export async function POST(req: Request) {
  if (wallet().kind !== "mock") {
    return Response.json({ error: "disabled", reason: "MOCK_MODE is off" }, { status: 403 });
  }
  let body: { payment_hash?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "bad_request" }, { status: 400 }); }
  if (!body.payment_hash) return Response.json({ error: "bad_request", reason: "payment_hash required" }, { status: 400 });

  const preimage = mockPreimageFor(body.payment_hash);
  if (!preimage) return Response.json({ error: "not_found", reason: "no such invoice" }, { status: 404 });

  return Response.json({ paid: true, preimage, note: "MOCK MODE — no actual sats moved" });
}
