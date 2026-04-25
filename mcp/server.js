#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  PayMyAgent — LUMEN MCP server.
//
//  Exposes six tools to any MCP host (Claude Desktop, Cursor, Claude
//  Code, etc.) so a human can hand the agent a Lightning wallet plus
//  a sat budget and let it spend per task on LUMEN providers.
//
//    lumen_status          (free) wallet mode, budget, remaining, provider URL
//    lumen_discover        (free) what the connected provider sells
//    lumen_balance         (free) wallet balance via NWC
//    lumen_set_budget      (free) reset the per-session sat cap
//    lumen_verify_listing  (paid · ~240 sat) OSM-geocoded listing verification
//    lumen_file_receipt    (paid · ~120 sat) signed delivery receipt
//    lumen_fetch_receipt   (free) replay a receipt the agent already paid for
//
//  All paid tools route through lumen-client.js, which honours the
//  budget guardrail (budget.js) and the per-call cap (MAX_PRICE_SATS).
// ─────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  callPaidEndpoint, discover, fetchReceipt, balance, health, close,
  PROVIDER, MOCK, MAX_PRICE_SATS,
} from "./lumen-client.js";
import { getStatus as budgetStatus, setBudget } from "./budget.js";

// ─── helpers ──────────────────────────────────────────────────────────
const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, ...data, budget: budgetStatus() }, null, 2) }],
  structuredContent: { ok: true, ...data, budget: budgetStatus() },
});
const fail = (message, extra = {}) => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, budget: budgetStatus(), ...extra }, null, 2) }],
  structuredContent: { ok: false, error: message, budget: budgetStatus(), ...extra },
  isError: true,
});

// ─── server ───────────────────────────────────────────────────────────
const server = new McpServer({ name: "lumen-paymyagent", version: "0.1.0" });

server.registerTool(
  "lumen_status",
  {
    title: "LUMEN status",
    description:
      "Returns the connected LUMEN provider URL, the wallet mode (mock|real), the per-call cap, and the remaining sat budget for this session. Always-free; call this first if unsure of cost or capacity.",
    inputSchema: {},
  },
  async () => {
    let provider_health = null;
    try { provider_health = await health(); } catch (e) { provider_health = { ok: false, error: e.message }; }
    return ok({
      provider_url: PROVIDER,
      wallet_mode: MOCK ? "mock" : "real",
      max_price_per_call_sats: MAX_PRICE_SATS,
      provider_health,
    });
  },
);

server.registerTool(
  "lumen_discover",
  {
    title: "LUMEN discover",
    description:
      "Lists every paid service the connected LUMEN provider sells (price, p50 latency, request schema). Always-free; safe to call before deciding what to buy.",
    inputSchema: {},
  },
  async () => {
    try { return ok({ catalogue: await discover() }); }
    catch (e) { return fail(`discovery failed: ${e.message}`); }
  },
);

server.registerTool(
  "lumen_balance",
  {
    title: "LUMEN balance",
    description: "Reports the current Lightning wallet balance (via NWC). Free to call.",
    inputSchema: {},
  },
  async () => ok({ wallet: await balance() }),
);

server.registerTool(
  "lumen_set_budget",
  {
    title: "LUMEN set budget",
    description:
      "Reset the per-session spending cap (in sats). Resets the 'spent' counter to 0. Use this at the start of a task to give the agent an explicit budget; once exceeded, paid tools refuse.",
    inputSchema: {
      sats: z.number().int().positive().describe("Budget cap, in sats (1 sat ≈ 0.067¢ at $67k/btc)"),
    },
  },
  async ({ sats }) => {
    try { return ok({ message: "budget reset", new_status: setBudget(sats) }); }
    catch (e) { return fail(e.message); }
  },
);

server.registerTool(
  "lumen_verify_listing",
  {
    title: "LUMEN — verify listing",
    description:
      "Pays the LUMEN provider (typically 240 sat) to verify a place exists on OpenStreetMap. " +
      "Returns real coordinates, the resolved place name, an OSM id, and an HMAC-signed proof. " +
      "Spends real Lightning sats unless MOCK_MODE=true on the server. Use lumen_status to confirm cost first.",
    inputSchema: {
      listing: z.string().min(2).describe("Place name, e.g. 'Hotel Adlon Berlin', 'Eiffel Tower Paris'"),
      date:    z.string().describe("ISO-8601 date (YYYY-MM-DD) for the listing's intended use"),
      max_age_h: z.number().int().positive().optional().describe("Max acceptable age of cached imagery (hours, default 24)"),
    },
  },
  async ({ listing, date, max_age_h }) => {
    try {
      const r = await callPaidEndpoint("/api/v1/listing-verify", { listing, date, max_age_h: max_age_h ?? 24 });
      return ok({
        spent_sats: r.spent_sats,
        round_trip_ms: r.elapsed_ms,
        preimage: r.preimage,
        proof: r.body,
      });
    } catch (e) { return fail(e.message); }
  },
);

server.registerTool(
  "lumen_file_receipt",
  {
    title: "LUMEN — file receipt",
    description:
      "Pays the LUMEN provider (typically 120 sat) to mint a signed delivery receipt for an order. " +
      "Pass the bolt-11 of the original purchase + an order_id; LUMEN extracts the amount/network/payment_hash, signs a claims envelope, and stores it for replay.",
    inputSchema: {
      order_id: z.string().min(1),
      invoice:  z.string().min(10).describe("bolt-11 invoice for the original order (lnbc…)"),
      buyer:    z.string().optional(),
      notes:    z.string().optional(),
    },
  },
  async ({ order_id, invoice, buyer, notes }) => {
    try {
      const r = await callPaidEndpoint("/api/v1/order-receipt", { order_id, invoice, buyer, notes });
      return ok({
        spent_sats:    r.spent_sats,
        round_trip_ms: r.elapsed_ms,
        receipt:       r.body,
      });
    } catch (e) { return fail(e.message); }
  },
);

server.registerTool(
  "lumen_fetch_receipt",
  {
    title: "LUMEN — fetch receipt",
    description:
      "Free replayable read of a receipt the agent has already paid to mint. Returns the same signed claims envelope; signature must validate against the provider's L402_SECRET.",
    inputSchema: {
      receipt_id: z.string().min(1).describe("The rcpt_… id returned by lumen_file_receipt"),
    },
  },
  async ({ receipt_id }) => {
    try { return ok({ receipt: await fetchReceipt(receipt_id) }); }
    catch (e) { return fail(e.message); }
  },
);

// ─── connect ──────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[lumen-mcp] ready · provider=${PROVIDER} mode=${MOCK ? "mock" : "real"} budget=${budgetStatus().budget_sats} sat\n`);
}

process.on("SIGINT",  () => { close(); process.exit(0); });
process.on("SIGTERM", () => { close(); process.exit(0); });

main().catch((err) => {
  process.stderr.write(`[lumen-mcp] fatal: ${err.message}\n`);
  process.exit(1);
});
