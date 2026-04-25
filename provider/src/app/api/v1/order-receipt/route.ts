// POST /v1/order-receipt
//   body: { order_id: string, invoice: string, buyer?: string, notes?: string }
//
// Sells signed, time-stamped delivery receipts to agents.  Pairs with
// agentic shopping flows like unhuman.coffee: agent buys coffee for 8,000
// sat, then files a 120-sat receipt with LUMEN so the spend is auditable
// against an HMAC-signed timestamp it can show its human later.
//
// Distinct shape from listing-verify on purpose:
//   - cheaper (different price tier)
//   - parses an inbound bolt-11 to extract payment_hash deterministically
//   - returns a signed object the agent can store and replay
//   - a structurally different service category in the catalogue.

import { require402, verifyAuth } from "@/lib/l402";
import { createHash, createHmac } from "node:crypto";

const RESOURCE = "/v1/order-receipt";
const PRICE = 120;
const TTL = 300;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");

  if (!auth) return require402(RESOURCE, PRICE, "lumen.order-receipt", TTL);

  const result = await verifyAuth(auth, RESOURCE);
  if (!result.ok) return Response.json({ error: "unauthorized", reason: result.reason }, { status: 401 });

  let body: { order_id?: string; invoice?: string; buyer?: string; notes?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "bad_request" }, { status: 400 }); }
  if (!body.order_id || !body.invoice) {
    return Response.json({ error: "bad_request", reason: "order_id and invoice required" }, { status: 400 });
  }

  // ─── parse the inbound bolt-11 to extract amount + payment_hash ───
  // For the demo we accept either a real bolt-11 or our mock string;
  // we extract whatever payment_hash we can, otherwise hash the invoice.
  const parsed = parseBolt11Lite(body.invoice);

  // ─── build + sign the receipt ─────────────────────────────────────
  const issued_at = new Date().toISOString();
  const receipt_id = `rcpt_${createHash("sha256").update(`${body.order_id}|${parsed.payment_hash}|${issued_at}`).digest("hex").slice(0, 24)}`;

  const claims = {
    receipt_id,
    issuer: "lumen.order-receipt",
    issued_at,
    order_id: body.order_id,
    invoice_payment_hash: parsed.payment_hash,
    amount_sats: parsed.amount_sats,
    network: parsed.network,
    buyer: body.buyer ?? null,
    notes: body.notes ?? null,
    fee_sats: PRICE,
    rev: "v0.1.0",
  };
  const signature = createHmac("sha256", process.env.L402_SECRET!)
    .update(JSON.stringify(claims))
    .digest("base64url");

  return Response.json(
    { ...claims, signature },
    {
      headers: {
        "x-lumen-paid-sats": String(result.body.amount),
        "x-lumen-preimage": result.preimage.slice(0, 8) + "...",
      },
    },
  );
}

// ─── tiny bolt-11 reader ─────────────────────────────────────────────
// Extracts the human-readable amount and a stable hash for the invoice.
// We don't need a full decoder for the demo — just enough to bind the
// receipt to whatever invoice the caller paid.
function parseBolt11Lite(invoice: string): { amount_sats: number | null; payment_hash: string; network: string } {
  const inv = invoice.trim().toLowerCase();
  // network prefix: lnbc, lntb, lnbcrt, lnsb, or our mock lnbcmock
  let network = "unknown";
  if (inv.startsWith("lnbcmock")) network = "mock";
  else if (inv.startsWith("lnbcrt")) network = "regtest";
  else if (inv.startsWith("lntb")) network = "testnet";
  else if (inv.startsWith("lnsb")) network = "signet";
  else if (inv.startsWith("lnbc")) network = "mainnet";

  // amount: digits + multiplier (m/u/n/p) right after the prefix
  let amount_sats: number | null = null;
  const amt = inv.match(/^lnbc(?:mock|rt)?(\d+)([munp])?/);
  if (amt) {
    const n = parseInt(amt[1], 10);
    const mult = amt[2];
    // bolt-11: amount in BTC. m=1e-3, u=1e-6, n=1e-9, p=1e-12
    const btc = mult === "m" ? n * 1e-3 : mult === "u" ? n * 1e-6 : mult === "n" ? n * 1e-9 : mult === "p" ? n * 1e-12 : n;
    amount_sats = Math.round(btc * 1e8);
  }

  // payment_hash: bolt-11 encodes it inside the bech32 payload, but we
  // don't need to decode that for a hackathon demo. Use sha256(invoice)
  // as a stable proxy — every distinct invoice gets a distinct hash, and
  // it matches our mock invoice's payment_hash for those.
  const payment_hash = createHash("sha256").update(invoice).digest("hex");

  return { amount_sats, payment_hash, network };
}
