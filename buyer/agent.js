// ─────────────────────────────────────────────────────────────────────
//  LUMEN buyer — single-call agent.
//  Verifies a listing via /v1/listing-verify, prints a 6-step receipt.
// ─────────────────────────────────────────────────────────────────────

import { callPaidEndpoint, closeLn, printer, c, PROVIDER, MOCK, MAX_PRICE } from "./lumen.js";

const args = {
  listing:   process.argv[2] || "hotel-larix-meribel",
  date:      process.argv[3] || "2026-03-14",
  max_age_h: 24,
};

console.log(c.bold(c.amber("LUMEN buyer  ·  tripplanner-7")));
console.log(c.dim(`provider: ${PROVIDER}   mode: ${MOCK ? "MOCK" : "REAL"}   max_price: ${MAX_PRICE} sat`));
console.log(c.dim(`task: verify ${args.listing} on ${args.date}`));

const t0 = Date.now();
const onStep = printer(t0);

try {
  const r = await callPaidEndpoint("/api/v1/listing-verify", args, { onStep });

  // print proof + summary
  console.log(`\n${c.amber("▌ STEP 5")}  ${c.bold("Receipt")}  ${c.dim(`+${Date.now() - t0}ms`)}`);
  console.log(c.dim("  ─ proof " + "─".repeat(56)));
  for (const [k, v] of Object.entries(r.body)) {
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    console.log(`  ${c.dim(k.padEnd(14))}  ${k === "verified" ? (v ? c.green(val) : c.red(val)) : c.cyan(val)}`);
  }
  console.log(c.dim("  ─ summary " + "─".repeat(54)));
  console.log(`  ${c.dim("total_spent".padEnd(14))}  ${c.amber(`${r.spent_sats} sat   `)}${c.dim(`(≈ $${(r.spent_sats * 0.00067).toFixed(4)})`)}`);
  console.log(`  ${c.dim("total_fees".padEnd(14))}  ${c.amber(`${r.fees_paid} sat`)}`);
  console.log(`  ${c.dim("round_trip".padEnd(14))}  ${c.cyan(`${r.elapsed_ms} ms`)}`);

  console.log(`\n${c.green("done.")}`);
  closeLn();
  process.exit(0);
} catch (e) {
  console.error(`\n${c.red("error:")} ${e.message}`);
  closeLn();
  process.exit(1);
}
