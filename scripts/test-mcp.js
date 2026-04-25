// ─────────────────────────────────────────────────────────────────────
//  PayMyAgent — MCP probe end-to-end.
//
//  1. Spawns the LUMEN provider (mock mode, fresh DB).
//  2. Spawns the MCP server (mock mode) over stdio.
//  3. Calls list_tools — asserts all six tools are present.
//  4. Calls lumen_status / lumen_discover — asserts free metadata works.
//  5. Calls lumen_set_budget(1000), then lumen_verify_listing — asserts
//     the paid call succeeded, returned a proof, and the budget moved.
//  6. Calls lumen_verify_listing five more times — asserts the budget
//     guardrail fires when the cap would be breached.
//  7. Calls lumen_fetch_receipt with a bogus id — asserts ok=false.
//
//  Run:  node scripts/test-mcp.js
// ─────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const provider = path.join(root, "provider");
const mcpDir  = path.join(root, "mcp");
const dbFile  = path.join(root, "lumen.db");
const sessionFile = path.join(root, ".mcp-session.json");
const PROVIDER = "http://localhost:3000";

const c = {
  amber: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
  green: (s) => `\x1b[38;5;120m${s}\x1b[0m`,
  red:   (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[38;5;87m${s}\x1b[0m`,
  dim:   (s) => `\x1b[38;5;245m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
};
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ${c.green("✓")} ${m}`); };
const ko = (m) => { fail++; console.log(`  ${c.red("✗")} ${m}`); };

// ─── kill anything still on dev ports ────────────────────────────────
async function killStaleDevServers() {
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn("netstat", ["-ano"], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let s = ""; p.stdout.on("data", (d) => (s += d)); p.on("exit", () => resolve(s));
    });
    const pids = [...new Set(out.split(/\r?\n/)
      .filter((l) => /:300[0-9]\s/.test(l) && l.includes("LISTENING"))
      .map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))];
    for (const pid of pids) {
      await new Promise((r) => spawn("taskkill", ["/PID", pid, "/F", "/T"], { shell: true, stdio: "ignore" }).on("exit", r));
    }
    if (pids.length) await wait(500);
  } catch {}
}

// ─── start LUMEN provider in mock mode ───────────────────────────────
async function startProvider() {
  const proc = spawn("npm", ["run", "dev", "--prefix", provider], {
    shell: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOCK_MODE: "true" },
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${PROVIDER}/api/health`, { signal: AbortSignal.timeout(800) });
      if (r.status === 200) {
        try { await fetch(`${PROVIDER}/api/v1/discovery`, { signal: AbortSignal.timeout(2000) }); } catch {}
        return proc;
      }
    } catch {}
    await wait(300);
  }
  proc.kill(); throw new Error("provider didn't become reachable on :3000 in 45s");
}
async function stopProvider(proc) {
  return new Promise((resolve) => {
    proc.on("exit", resolve);
    proc.kill("SIGTERM");
    setTimeout(async () => { await killStaleDevServers(); resolve(null); }, 1500);
  });
}

// ─── go ──────────────────────────────────────────────────────────────
console.log(c.bold(c.amber("PayMyAgent MCP probe")));
console.log(c.dim("MOCK_MODE forced. Fresh DB + session."));

await killStaleDevServers();
await wait(500);
for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm", sessionFile]) {
  if (!fs.existsSync(f)) continue;
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(f, { force: true }); break; }
    catch (e) {
      if (i === 9) throw e;
      await wait(250);
    }
  }
}

console.log(`\n${c.amber("▌ boot")}  starting provider …`);
const prov = await startProvider();
ok("provider up");

console.log(`\n${c.amber("▌ mcp")}   connecting client over stdio …`);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(mcpDir, "server.js")],
  env: {
    ...process.env,
    LUMEN_PROVIDER_URL: PROVIDER,
    MOCK_MODE: "true",
    MAX_PRICE_SATS: "4000",
    MAX_BUDGET_SATS: "5000",
  },
  cwd: mcpDir,
});
const client = new Client({ name: "lumen-probe", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);
ok("mcp client connected");

// ─── STEP 1 — list_tools ─────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 1")}  list_tools — six LUMEN tools`);
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
const expected = ["lumen_balance", "lumen_discover", "lumen_fetch_receipt", "lumen_file_receipt", "lumen_set_budget", "lumen_status", "lumen_verify_listing"];
const missing = expected.filter((n) => !names.includes(n));
if (missing.length === 0) ok(`all ${expected.length} tools present`);
else                       ko(`missing: ${missing.join(", ")}`);

// helper: parse the structured payload from a tool result
const parseResult = (res) => {
  if (res.structuredContent) return res.structuredContent;
  try { return JSON.parse(res.content?.[0]?.text ?? "{}"); } catch { return {}; }
};

// ─── STEP 2 — status + discover ──────────────────────────────────────
console.log(`\n${c.amber("▌ step 2")}  free metadata calls`);
const s1 = parseResult(await client.callTool({ name: "lumen_status", arguments: {} }));
if (s1.ok && s1.wallet_mode === "mock") ok("lumen_status reports mode=mock");
else ko(`status: ${JSON.stringify(s1).slice(0, 120)}`);

const d1 = parseResult(await client.callTool({ name: "lumen_discover", arguments: {} }));
const services = d1.catalogue?.services ?? [];
if (services.length === 2) ok("lumen_discover lists 2 services");
else ko(`discover services count = ${services.length}`);

// ─── STEP 3 — set budget then verify listing ─────────────────────────
console.log(`\n${c.amber("▌ step 3")}  set_budget(1000) then verify a listing`);
const sb = parseResult(await client.callTool({ name: "lumen_set_budget", arguments: { sats: 1000 } }));
if (sb.ok && sb.budget?.budget_sats === 1000 && sb.budget?.spent_sats === 0) ok("budget reset to 1000, spent reset to 0");
else ko(`set_budget: ${JSON.stringify(sb).slice(0, 200)}`);

const v1 = parseResult(await client.callTool({
  name: "lumen_verify_listing",
  arguments: { listing: "Eiffel Tower Paris", date: "2026-03-14" },
}));
if (v1.ok && v1.proof?.verified === true) ok(`paid call succeeded; verified=true; spent ${v1.spent_sats} sat`);
else ko(`verify: ${JSON.stringify(v1).slice(0, 250)}`);
if (v1.ok && v1.budget?.spent_sats === v1.spent_sats) ok(`budget tracker reflects spend (${v1.budget.spent_sats}/${v1.budget.budget_sats})`);
else ko(`budget tracker mismatch: ${JSON.stringify(v1.budget)}`);

// ─── STEP 4 — file a receipt for the same invoice ────────────────────
console.log(`\n${c.amber("▌ step 4")}  file a receipt referencing that invoice`);
const orderId = "ord_" + Math.random().toString(36).slice(2, 10);
const verify1invoice = "lnbcMOCK240u1" + (v1.preimage ?? "deadbeef").slice(0, 40);  // we don't have the original invoice; pass any bolt-11-shaped string
const fr = parseResult(await client.callTool({
  name: "lumen_file_receipt",
  arguments: { order_id: orderId, invoice: verify1invoice, buyer: "tripplanner-7", notes: "verified" },
}));
if (fr.ok && fr.receipt?.receipt_id?.startsWith("rcpt_")) ok(`receipt minted: ${fr.receipt.receipt_id}`);
else ko(`file_receipt: ${JSON.stringify(fr).slice(0, 250)}`);

// fetch it back (free)
if (fr.ok) {
  const fetched = parseResult(await client.callTool({
    name: "lumen_fetch_receipt", arguments: { receipt_id: fr.receipt.receipt_id },
  }));
  if (fetched.ok && fetched.receipt?.signature === fr.receipt.signature) ok("fetch_receipt round-trip; signature stable");
  else ko(`fetch mismatch: ${JSON.stringify(fetched).slice(0, 200)}`);
}

// ─── STEP 5 — budget guardrail ───────────────────────────────────────
console.log(`\n${c.amber("▌ step 5")}  budget guardrail blocks the call that would breach it`);
let blocked = 0, succeeded = 0;
for (let i = 0; i < 5; i++) {
  const r = parseResult(await client.callTool({
    name: "lumen_verify_listing",
    arguments: { listing: `attempt-${i}`, date: "2026-03-14" },
  }));
  if (r.ok) succeeded++;
  else if ((r.error ?? "").includes("budget exceeded")) blocked++;
}
if (blocked > 0) ok(`${succeeded} more calls succeeded, ${blocked} blocked by budget cap`);
else ko(`no budget refusals seen (succeeded=${succeeded})`);

// ─── STEP 6 — bogus receipt id ───────────────────────────────────────
console.log(`\n${c.amber("▌ step 6")}  unknown receipt id → ok=false (no crash)`);
const bogus = parseResult(await client.callTool({
  name: "lumen_fetch_receipt", arguments: { receipt_id: "rcpt_does_not_exist" },
}));
if (!bogus.ok && /no such receipt|404|receipt fetch/.test(bogus.error ?? "")) ok("bogus id surfaced as a clean error");
else ko(`bogus id: ${JSON.stringify(bogus).slice(0, 200)}`);

// ─── teardown ─────────────────────────────────────────────────────────
await client.close();
await stopProvider(prov);

console.log("");
if (fail === 0) console.log(c.green(`PASS · ${pass}/${pass} checks`));
else            console.log(c.red(`FAIL · ${fail} of ${pass + fail} checks failed`));
process.exit(fail === 0 ? 0 : 1);
