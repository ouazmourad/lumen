// ─────────────────────────────────────────────────────────────────────
//  LUMEN buyer — multi-service flow.
//
//  Imagine you, the human, asked your travel agent to book a hotel.
//  The agent does three things back-to-back, all paid with Lightning,
//  no card on file, no API keys, no checkout, no human in the loop:
//
//    1. /v1/discovery       free        scout the menu
//    2. /v1/listing-verify  240 sat     prove the hotel is real
//    3. /v1/order-receipt   120 sat     file an audit trail your human can read
//
//  Total: 360 sat (~$0.24), ~2s end-to-end, two services on one wallet.
// ─────────────────────────────────────────────────────────────────────

import { callPaidEndpoint, closeLn, printer, c, PROVIDER, MOCK, MAX_PRICE } from "./lumen.js";

const listing = process.argv[2] || "Hotel Adlon Berlin";
const date    = process.argv[3] || "2026-03-14";
const order   = `ord_${Math.random().toString(36).slice(2, 10)}`;

console.log(c.bold(c.amber("LUMEN buyer  ·  tripplanner-7  ·  multi-service flow")));
console.log(c.dim(`provider: ${PROVIDER}   mode: ${MOCK ? "MOCK" : "REAL"}   cap: ${MAX_PRICE} sat`));
console.log(c.dim(`task: verify ${listing} on ${date}, then file receipt for order ${order}`));

const t0 = Date.now();
const onStep = printer(t0);

try {
  // ── 0 · Discovery (free) ─────────────────────────────────────────
  console.log(`\n${c.amber("▌ STEP 0")}  ${c.bold("GET /v1/discovery")}  ${c.dim("(free; scout the menu)")}`);
  const dRes = await fetch(`${PROVIDER}/api/v1/discovery`);
  const directory = await dRes.json();
  console.log(`  ${c.dim("provider".padEnd(14))}  ${c.cyan(directory.provider.id)} · ${c.dim(directory.provider.payment.network)}`);
  console.log(`  ${c.dim("services".padEnd(14))}  ${c.cyan(directory.services.length + " offered")}`);
  for (const s of directory.services) {
    console.log(`  ${c.dim("·".padEnd(14))}  ${s.id.padEnd(16)} ${c.amber(s.price_sats + " sat".padEnd(8))} ${c.dim(`p50=${s.p50_ms}ms  · ${s.category}`)}`);
  }

  // ── 1 · listing-verify (240 sat) ─────────────────────────────────
  console.log(`\n${c.bold(c.cyan("─── service 1 of 2 · listing-verify ─────────────────────────"))}`);
  const verify = await callPaidEndpoint(
    "/api/v1/listing-verify",
    { listing, date, max_age_h: 24 },
    { onStep },
  );
  console.log(`  ${c.dim("verified".padEnd(14))}  ${verify.body.verified ? c.green("true") : c.red("false")}  ${c.dim(`conf ${verify.body.confidence}`)}`);
  console.log(`  ${c.dim("resolved".padEnd(14))}  ${c.cyan(verify.body.resolved_name ?? "(synthetic)")}`);
  console.log(`  ${c.dim("geo".padEnd(14))}  ${c.cyan(JSON.stringify(verify.body.exif_geo))}  ${c.dim(verify.body.geo_source)}`);

  if (!verify.body.verified) {
    console.log(`\n${c.red("verification failed; not filing a receipt.")}`);
    closeLn();
    process.exit(1);
  }

  // ── 2 · order-receipt (120 sat) ──────────────────────────────────
  console.log(`\n${c.bold(c.cyan("─── service 2 of 2 · order-receipt ──────────────────────────"))}`);
  const receipt = await callPaidEndpoint(
    "/api/v1/order-receipt",
    {
      order_id: order,
      invoice:  verify.paid_invoice,    // bind the receipt to the verify-invoice
      buyer:    "tripplanner-7",
      notes:    `verified ${verify.body.resolved_name ?? listing} on ${date}`,
    },
    { onStep },
  );
  console.log(`  ${c.dim("receipt_id".padEnd(14))}  ${c.cyan(receipt.body.receipt_id)}`);
  console.log(`  ${c.dim("issued_at".padEnd(14))}  ${c.cyan(receipt.body.issued_at)}`);
  console.log(`  ${c.dim("signature".padEnd(14))}  ${c.dim(receipt.body.signature.slice(0, 32) + "…")}`);

  // ── summary ──────────────────────────────────────────────────────
  const total_spent = verify.spent_sats + receipt.spent_sats;
  const total_fees  = verify.fees_paid + receipt.fees_paid;
  console.log(`\n${c.amber("▌ summary")}  ${c.dim(`+${Date.now() - t0}ms`)}`);
  console.log(c.dim("  ─ tape " + "─".repeat(58)));
  console.log(`  ${c.dim("listing-verify".padEnd(16))}  ${c.amber(verify.spent_sats + " sat ").padEnd(20)}  ${c.cyan(verify.elapsed_ms + " ms".padStart(8))}`);
  console.log(`  ${c.dim("order-receipt".padEnd(16))}   ${c.amber(receipt.spent_sats + " sat ").padEnd(20)}  ${c.cyan(receipt.elapsed_ms + " ms".padStart(8))}`);
  console.log(c.dim("  " + "─".repeat(64)));
  console.log(`  ${c.dim("total spent".padEnd(16))}    ${c.amber(`${total_spent} sat`).padEnd(20)}  ${c.dim(`(≈ $${(total_spent * 0.00067).toFixed(4)})`)}`);
  console.log(`  ${c.dim("total fees".padEnd(16))}     ${c.amber(`${total_fees} sat`)}`);
  console.log(`  ${c.dim("round trip".padEnd(16))}     ${c.cyan(`${Date.now() - t0} ms`)}`);

  console.log(`\n${c.green("done — two services, one wallet, no human.")}`);
  closeLn();
  process.exit(0);
} catch (e) {
  console.error(`\n${c.red("error:")} ${e.message}`);
  closeLn();
  process.exit(1);
}
