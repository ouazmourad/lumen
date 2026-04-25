// ─────────────────────────────────────────────────────────────────────
//  LUMEN client lib — extracted from agent.js so multiple flows can
//  share one wallet and one console-formatting style.
// ─────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { LNClient } from "@getalby/sdk";

export const PROVIDER = process.env.PROVIDER_URL || "http://localhost:3000";
export const MOCK = process.env.MOCK_MODE === "true";
export const MAX_PRICE = parseInt(process.env.MAX_PRICE_SATS || "4000", 10);

export const c = {
  amber: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[38;5;87m${s}\x1b[0m`,
  green: (s) => `\x1b[38;5;120m${s}\x1b[0m`,
  red:   (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  dim:   (s) => `\x1b[38;5;245m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
};

// ─── one shared LN client across all calls in a session ─────────────
let _ln;
function ln() {
  if (!_ln) {
    if (!process.env.NWC_URL) throw new Error("NWC_URL is empty in .env");
    _ln = new LNClient(process.env.NWC_URL);
  }
  return _ln;
}
export function closeLn() { try { _ln?.close(); _ln = null; } catch {} }

// ─── pay any L402 challenge ─────────────────────────────────────────
async function pay(challenge) {
  if (MOCK) {
    const r = await fetch(`${PROVIDER}/api/dev/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment_hash: challenge.payment_hash }),
    });
    if (!r.ok) throw new Error(`mock pay failed: ${r.status}`);
    const j = await r.json();
    return { preimage: j.preimage, fees_paid: 0, invoice: challenge.invoice };
  }
  const res = await ln().pay(challenge.invoice);
  return { preimage: res.preimage, fees_paid: res.fees_paid ?? 0, invoice: challenge.invoice };
}

// ─── core: hit a paid endpoint, settle, replay, return parsed body ──
//   path:    "/api/v1/listing-verify"
//   args:    request body
//   onStep:  (n, label, kvs[]) => void   — hook for printing
//   maxPrice: optional override of MAX_PRICE
export async function callPaidEndpoint(path, args, { onStep = () => {}, maxPrice = MAX_PRICE } = {}) {
  const t0 = Date.now();

  // ── 1. ask for it; expect 402 ────────────────────────────────────
  const r = await fetch(`${PROVIDER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}: ${await r.text()}`);
  const challenge = await r.json();
  onStep(1, `POST ${path} → 402`, [
    ["price",        c.amber(`${challenge.amount_sats} sat`)],
    ["payment_hash", c.dim(challenge.payment_hash)],
    ["invoice",      c.dim(challenge.invoice.slice(0, 60) + (challenge.invoice.length > 60 ? "…" : ""))],
  ]);

  // ── 2. policy ────────────────────────────────────────────────────
  if (challenge.amount_sats > maxPrice) throw new Error(`price ${challenge.amount_sats} > cap ${maxPrice}`);
  onStep(2, "policy ✓", [["cap/call", c.green(`${challenge.amount_sats} ≤ ${maxPrice} sat`)]]);

  // ── 3. pay ───────────────────────────────────────────────────────
  const paid = await pay(challenge);
  onStep(3, MOCK ? "pay (mock)" : "pay (real Lightning)", [
    ["preimage", c.green(paid.preimage.slice(0, 16) + "…")],
    ["fees",     c.amber(`${paid.fees_paid} sat`)],
  ]);

  // ── 4. replay ────────────────────────────────────────────────────
  const r2 = await fetch(`${PROVIDER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `L402 ${challenge.macaroon}:${paid.preimage}` },
    body: JSON.stringify(args),
  });
  if (!r2.ok) throw new Error(`replay failed: ${r2.status} ${await r2.text()}`);
  const result = await r2.json();
  onStep(4, "replay → 200", [["paid_sats", c.green(r2.headers.get("x-lumen-paid-sats") ?? "-")]]);

  return {
    ok: true,
    spent_sats: challenge.amount_sats,
    fees_paid: paid.fees_paid,
    paid_invoice: paid.invoice,
    preimage: paid.preimage,
    elapsed_ms: Date.now() - t0,
    body: result,
  };
}

// ─── tiny printer used by both buyer scripts ─────────────────────────
export function printer(t0 = Date.now()) {
  const ts = () => c.dim(`+${(Date.now() - t0).toString().padStart(5, " ")}ms`);
  return (n, label, kvs = []) => {
    console.log(`\n${c.amber(`▌ STEP ${n}`)}  ${c.bold(label)}  ${ts()}`);
    for (const [k, v] of kvs) console.log(`  ${c.dim(k.padEnd(14))}  ${v}`);
  };
}
