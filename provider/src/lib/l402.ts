// ─────────────────────────────────────────────────────────────────────
//  L402 — pay-per-call paywall in ~80 lines.
//
//  Spec sketch:
//    1. Server returns 402 with header:
//         WWW-Authenticate: L402 macaroon="<b64>", invoice="<bolt11>"
//    2. Client pays the invoice → gets back a preimage.
//    3. Client retries with header:
//         Authorization: L402 <macaroon>:<preimage>
//    4. Server verifies SHA256(preimage)===payment_hash AND macaroon HMAC.
//
//  The "macaroon" here is a minimal signed token: base64(json).hmac.
//  Real L402 macaroons are bakery tokens; this preserves the spirit
//  (caveat-free capability) while being simple to audit.
// ─────────────────────────────────────────────────────────────────────

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { wallet, type Invoice } from "./wallet";

const SECRET = () => {
  const s = process.env.L402_SECRET;
  if (!s || s.length < 32) throw new Error("L402_SECRET must be set and ≥32 chars");
  return s;
};

type MacaroonBody = {
  payment_hash: string;
  resource: string;
  amount: number;
  exp: number;            // unix seconds
};

// ─── macaroon mint / verify ──────────────────────────────────────────
function mintMacaroon(body: MacaroonBody): string {
  const json = JSON.stringify(body);
  const payload = Buffer.from(json).toString("base64url");
  const sig = createHmac("sha256", SECRET()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyMacaroon(macaroon: string): MacaroonBody | null {
  const [payload, sig] = macaroon.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", SECRET()).update(payload).digest("base64url");
  if (sig.length !== expected.length) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as MacaroonBody;
    if (body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

// ─── 402 response ────────────────────────────────────────────────────
export async function require402(
  resource: string,
  amount: number,
  description: string,
  ttlSec: number,
): Promise<Response> {
  const inv: Invoice = await wallet().makeInvoice(amount, description, ttlSec);
  const macaroon = mintMacaroon({
    payment_hash: inv.payment_hash,
    resource,
    amount,
    exp: inv.expires_at,
  });
  const challenge = `L402 macaroon="${macaroon}", invoice="${inv.invoice}"`;
  return new Response(
    JSON.stringify({
      error: "payment_required",
      message: `${amount} sats required for ${resource}`,
      invoice: inv.invoice,
      payment_hash: inv.payment_hash,
      amount_sats: amount,
      expires_at: inv.expires_at,
      macaroon,
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        "www-authenticate": challenge,
        "x-lumen-resource": resource,
        "x-lumen-amount-sats": String(amount),
      },
    },
  );
}

// ─── auth verification ───────────────────────────────────────────────
export type AuthResult =
  | { ok: true; body: MacaroonBody; preimage: string }
  | { ok: false; reason: string };

export async function verifyAuth(authHeader: string | null, expectedResource: string): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith("L402 ")) return { ok: false, reason: "missing L402 header" };
  const token = authHeader.slice(5).trim();
  const sep = token.indexOf(":");
  if (sep < 0) return { ok: false, reason: "malformed token" };
  const macaroon = token.slice(0, sep);
  const preimage = token.slice(sep + 1);

  const body = verifyMacaroon(macaroon);
  if (!body) return { ok: false, reason: "invalid macaroon" };
  if (body.resource !== expectedResource) return { ok: false, reason: "macaroon scoped to a different resource" };

  // SHA256(preimage) === payment_hash ?
  const preimageBuf = Buffer.from(preimage, "hex");
  if (preimageBuf.length !== 32) return { ok: false, reason: "preimage must be 32 bytes hex" };
  const hash = createHash("sha256").update(preimageBuf).digest("hex");
  if (hash !== body.payment_hash) return { ok: false, reason: "preimage does not match payment_hash" };

  // (mock mode skips this; real mode confirms the invoice actually settled)
  if (wallet().kind === "real") {
    const lookup = await wallet().lookupInvoice(body.payment_hash);
    if (!lookup.paid) return { ok: false, reason: "invoice not yet settled with the wallet" };
  }

  return { ok: true, body, preimage };
}
