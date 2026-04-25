// ─────────────────────────────────────────────────────────────────────
//  LUMEN buyer agent — auto-pays L402 paywalls.
//
//  Flow:
//    1. POST /v1/listing-verify  → 402 + invoice
//    2. parse the WWW-Authenticate header (macaroon, invoice)
//    3. pay (real wallet via NWC, or /api/dev/pay in mock mode)
//    4. POST again with Authorization: L402 <macaroon>:<preimage>
//    5. print the verification proof + receipt
//
//  Two modes:
//    MOCK_MODE=true   no wallet; provider hands us the preimage for free.
//    MOCK_MODE=false  real Lightning via @getalby/sdk LNClient (NWC).
// ─────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { LNClient } from "@getalby/sdk";

const PROVIDER = process.env.PROVIDER_URL || "http://localhost:3000";
const MOCK = process.env.MOCK_MODE === "true";
const MAX_PRICE = parseInt(process.env.MAX_PRICE_SATS || "4000", 10);
const TIMEOUT = parseInt(process.env.TIMEOUT_MS || "15000", 10);

// ─── tiny console helpers ────────────────────────────────────────────
const c = {
  amber:  (s) => `\x1b[38;5;214m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[38;5;87m${s}\x1b[0m`,
  green:  (s) => `\x1b[38;5;120m${s}\x1b[0m`,
  red:    (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  dim:    (s) => `\x1b[38;5;245m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};
const t0 = Date.now();
const ts = () => c.dim(`+${(Date.now() - t0).toString().padStart(5, " ")}ms`);
const step = (n, label) => console.log(`\n${c.amber(`▌ STEP ${n}`)}  ${c.bold(label)}  ${ts()}`);
const kv = (k, v) => console.log(`  ${c.dim(k.padEnd(14))}  ${v}`);

// ─── 1. fetch the resource (no auth) ──────────────────────────────────
async function resolveTask(args) {
  step(1, "POST /v1/listing-verify  (no auth — expecting 402)");

  const r = await fetch(`${PROVIDER}/api/v1/listing-verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });

  if (r.status !== 402) {
    throw new Error(`expected 402, got ${r.status}: ${await r.text()}`);
  }
  const challenge = r.headers.get("www-authenticate") || "";
  const body = await r.json();
  kv("status",       c.cyan("402 Payment Required"));
  kv("price",        c.amber(`${body.amount_sats} sat`));
  kv("payment_hash", c.dim(body.payment_hash));
  kv("invoice",      c.dim(body.invoice.slice(0, 60) + (body.invoice.length > 60 ? "…" : "")));
  kv("macaroon",     c.dim(body.macaroon.slice(0, 60) + "…"));

  // ─── 2. policy check ─────────────────────────────────────────────
  step(2, "Policy check");
  if (body.amount_sats > MAX_PRICE) {
    throw new Error(`price ${body.amount_sats} > MAX_PRICE_SATS ${MAX_PRICE}`);
  }
  kv("cap/call",     c.green(`${body.amount_sats} ≤ ${MAX_PRICE} sat ✓`));

  // ─── 3. pay ──────────────────────────────────────────────────────
  step(3, MOCK ? "Pay  (MOCK — provider hands us the preimage)" : "Pay  (REAL — Lightning over NWC)");
  const { preimage, fees_paid } = await pay(body);
  kv("preimage",     c.green(preimage.slice(0, 16) + "…"));
  kv("fees_paid",    c.amber(`${fees_paid} sat`));

  // ─── 4. replay with L402 auth ────────────────────────────────────
  step(4, "Replay with Authorization: L402 <macaroon>:<preimage>");
  const r2 = await fetch(`${PROVIDER}/api/v1/listing-verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `L402 ${body.macaroon}:${preimage}`,
    },
    body: JSON.stringify(args),
  });

  if (!r2.ok) throw new Error(`replay failed: ${r2.status} ${await r2.text()}`);
  const proof = await r2.json();

  kv("status",       c.green("200 OK"));
  kv("paid_sats",    r2.headers.get("x-lumen-paid-sats") ?? "-");

  // ─── 5. show the result ──────────────────────────────────────────
  step(5, "Receipt");
  console.log(c.dim("  ─ proof " + "─".repeat(56)));
  for (const [k, v] of Object.entries(proof)) {
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    console.log(`  ${c.dim(k.padEnd(14))}  ${k === "verified" ? (v ? c.green(val) : c.red(val)) : c.cyan(val)}`);
  }
  console.log(c.dim("  ─ summary " + "─".repeat(54)));
  kv("total_spent",  c.amber(`${body.amount_sats} sat   `) + c.dim(`(≈ $${(body.amount_sats * 0.00067).toFixed(4)} @ $67k/btc)`));
  kv("total_fees",   c.amber(`${fees_paid} sat`));
  kv("round_trip",   c.cyan(`${Date.now() - t0} ms`));

  return proof;
}

// ─── pay: dispatches to mock or real ──────────────────────────────────
async function pay(challenge) {
  if (MOCK) {
    const r = await fetch(`${PROVIDER}/api/dev/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment_hash: challenge.payment_hash }),
    });
    if (!r.ok) throw new Error(`mock pay failed: ${r.status}`);
    const j = await r.json();
    return { preimage: j.preimage, fees_paid: 0 };
  }
  // ─── real ──────────────────────────────────────────────────────
  if (!process.env.NWC_URL) {
    throw new Error("MOCK_MODE=false but NWC_URL is empty. Add your Alby Hub NWC string to buyer/.env");
  }
  const ln = new LNClient(process.env.NWC_URL);
  try {
    const res = await ln.pay(challenge.invoice);
    return { preimage: res.preimage, fees_paid: res.fees_paid ?? 0 };
  } finally {
    ln.close();
  }
}

// ─── entrypoint ──────────────────────────────────────────────────────
const args = {
  listing: process.argv[2] || "hotel-larix-meribel",
  date:    process.argv[3] || "2026-03-14",
  max_age_h: 24,
};

console.log(c.bold(c.amber("LUMEN buyer  ·  tripplanner-7")));
console.log(c.dim(`provider: ${PROVIDER}   mode: ${MOCK ? "MOCK" : "REAL"}   max_price: ${MAX_PRICE} sat`));
console.log(c.dim(`task: verify ${args.listing} on ${args.date}`));

const timer = setTimeout(() => { console.error(c.red(`\nTIMEOUT after ${TIMEOUT}ms`)); process.exit(1); }, TIMEOUT);

resolveTask(args)
  .then(() => { clearTimeout(timer); console.log(`\n${c.green("done.")}`); process.exit(0); })
  .catch((e) => { clearTimeout(timer); console.error(`\n${c.red("error:")} ${e.message}`); process.exit(1); });
