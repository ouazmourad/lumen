// ─────────────────────────────────────────────────────────────────────
//  Phase 1 acceptance test — runs the 7-step scenario end-to-end.
//
//  Steps (matches the plan):
//    1. POST listing-verify with no auth → 402 (capture macaroon).
//    2. SQLite has the row in `invoices` with status='pending'.
//    3. Pay (mock), replay → 200; row flips to 'consumed'.
//    4. Replay the SAME macaroon → 409 already_consumed.
//    5. Stop provider, restart, replay → still 409 (state survived).
//    6. Spam 50 requests in <2s → mid-stream we get 429s w/ Retry-After.
//    7. /api/v1/stats with no admin auth → 401; with creds → 200 + JSON.
//
//  Runs in MOCK_MODE (no sats moved).
//  Run:  node scripts/test-phase1.js
// ─────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const provider = path.join(root, "provider");
const dbFile = path.join(root, "lumen.db");
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

// ─── kill anything Next-dev-shaped on ports 3000-3010 ────────────────
async function killStaleDevServers() {
  try {
    const out = await run("netstat", ["-ano"], { capture: true });
    const lines = out.split(/\r?\n/)
      .filter((l) => /:300[0-9]\s/.test(l) && l.includes("LISTENING"));
    const pids = [...new Set(lines.map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))];
    for (const pid of pids) {
      try { await run("taskkill", ["/PID", pid, "/F", "/T"], { capture: true }); } catch {}
    }
    if (pids.length) await wait(500);
  } catch {}
}
const killPort3000 = killStaleDevServers;  // alias kept for callers

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let out = "", err = "";
    if (capture) {
      child.stdout.on("data", (d) => out += d);
      child.stderr.on("data", (d) => err += d);
    }
    child.on("exit", (code) => code === 0 || !capture ? resolve(out) : reject(new Error(err || `${cmd} exit ${code}`)));
    child.on("error", reject);
  });
}

// ─── start provider in mock mode ─────────────────────────────────────
async function startProvider() {
  const proc = spawn("npm", ["run", "dev", "--prefix", provider], {
    shell: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOCK_MODE: "true" },
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});

  // Active readiness probe: hit /api/health until it returns 200.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${PROVIDER}/api/health`, { signal: AbortSignal.timeout(800) });
      if (r.status === 200) {
        // warm a paid route once so first-call compile latency doesn't poison the test.
        try { await fetch(`${PROVIDER}/api/v1/discovery`, { signal: AbortSignal.timeout(2000) }); } catch {}
        return proc;
      }
    } catch { /* server not up yet */ }
    await wait(300);
  }
  proc.kill();
  throw new Error("provider didn't become reachable on :3000 in 45s");
}
function stopProvider(proc) {
  return new Promise(async (resolve) => {
    proc.on("exit", resolve);
    proc.kill("SIGTERM");
    setTimeout(async () => { await killPort3000(); resolve(null); }, 1500);
  });
}

// ─── helpers ─────────────────────────────────────────────────────────
const get = (p, h = {}) => fetch(`${PROVIDER}${p}`, { headers: h });
const post = (p, body, h = {}) => fetch(`${PROVIDER}${p}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...h },
  body: JSON.stringify(body),
});

// ─── go ──────────────────────────────────────────────────────────────
console.log(c.bold(c.amber("Phase 1 acceptance test")));
console.log(c.dim("MOCK_MODE forced. Existing lumen.db will be wiped."));

if (fs.existsSync(dbFile)) fs.rmSync(dbFile, { force: true });
const dbWal = dbFile + "-wal", dbShm = dbFile + "-shm";
if (fs.existsSync(dbWal)) fs.rmSync(dbWal, { force: true });
if (fs.existsSync(dbShm)) fs.rmSync(dbShm, { force: true });
await killPort3000();

console.log(`\n${c.amber("▌ boot 1")}  starting provider …`);
let prov = await startProvider();
ok("provider up");

// ─── STEP 1 ──────────────────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 1")}  POST listing-verify (no auth) → 402`);
const r1 = await post("/api/v1/listing-verify", { listing: "Eiffel Tower Paris", date: "2026-03-14" });
const j1 = await r1.json();
if (r1.status === 402) ok("status 402");
else ko(`status was ${r1.status}`);
if (j1.macaroon && j1.payment_hash && j1.invoice) ok("envelope has macaroon/payment_hash/invoice");
else ko("envelope missing fields");
if (j1.request_id?.startsWith("req_")) ok("error envelope carries request_id");
else ko("missing request_id in envelope");

// ─── STEP 2 ──────────────────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 2")}  SQLite row exists with status=pending`);
const db = new Database(dbFile, { readonly: true });
const row = db.prepare("SELECT status, resource, amount_sats FROM invoices WHERE payment_hash = ?").get(j1.payment_hash);
db.close();
if (row?.status === "pending") ok("invoice row status=pending");
else ko(`invoice row missing or wrong status: ${JSON.stringify(row)}`);
if (row?.resource === "/v1/listing-verify" && row?.amount_sats === 240) ok("row carries resource + amount_sats");
else ko(`row metadata wrong: ${JSON.stringify(row)}`);

// ─── STEP 3 ──────────────────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 3")}  pay (mock) + replay → 200, row flips to consumed`);
const pay = await (await post("/api/dev/pay", { payment_hash: j1.payment_hash })).json();
if (pay.preimage) ok("dev pay returned preimage");
else ko("dev pay failed");

const r3 = await post("/api/v1/listing-verify",
  { listing: "Eiffel Tower Paris", date: "2026-03-14" },
  { authorization: `L402 ${j1.macaroon}:${pay.preimage}` });
const j3 = await r3.json();
if (r3.status === 200 && j3.verified === true) ok("replay → 200, verified=true");
else ko(`replay status ${r3.status}, body: ${JSON.stringify(j3).slice(0, 120)}`);

const db2 = new Database(dbFile, { readonly: true });
const row2 = db2.prepare("SELECT status, preimage FROM invoices WHERE payment_hash = ?").get(j1.payment_hash);
db2.close();
if (row2?.status === "consumed") ok("invoice row flipped to status=consumed");
else ko(`row status is ${row2?.status}`);

// ─── STEP 4 ──────────────────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 4")}  same macaroon replay → 409 already_consumed`);
const r4 = await post("/api/v1/listing-verify",
  { listing: "Eiffel Tower Paris", date: "2026-03-14" },
  { authorization: `L402 ${j1.macaroon}:${pay.preimage}` });
const j4 = await r4.json();
if (r4.status === 409 && j4.error === "already_consumed") ok("status 409 + error=already_consumed");
else ko(`got ${r4.status} ${j4.error}`);

// ─── STEP 5 ──────────────────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 5")}  restart provider; same replay still → 409 (state survived)`);
await stopProvider(prov);
prov = await startProvider();
ok("provider restarted");
const r5 = await post("/api/v1/listing-verify",
  { listing: "Eiffel Tower Paris", date: "2026-03-14" },
  { authorization: `L402 ${j1.macaroon}:${pay.preimage}` });
const j5 = await r5.json();
if (r5.status === 409 && j5.error === "already_consumed") ok("status 409 across restart — state persisted");
else ko(`got ${r5.status} ${j5.error}`);

// ─── STEP 6 ──────────────────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 6")}  spam 60 requests; later ones get 429 + Retry-After`);
const fired = [];
for (let i = 0; i < 60; i++) fired.push(post("/api/v1/listing-verify", { listing: `x${i}`, date: "2026-03-14" }));
const all = await Promise.all(fired);
const codes = all.map((r) => r.status);
const limited = all.filter((r) => r.status === 429);
const ra = limited[0]?.headers.get("retry-after");
if (limited.length > 0) ok(`${limited.length}/60 hit 429`);
else ko(`no 429s observed; codes: ${[...new Set(codes)].join(",")}`);
if (ra && parseInt(ra, 10) > 0) ok(`Retry-After header present: ${ra}s`);
else ko("Retry-After header missing");

// ─── recover + refill ────────────────────────────────────────────────
// The 60-concurrent spam can knock Next dev over; if it did, restart.
await wait(2500);
try {
  const probe = await fetch(`${PROVIDER}/api/health`, { signal: AbortSignal.timeout(1500) });
  if (probe.status !== 200) throw new Error(`health ${probe.status}`);
} catch {
  console.log(c.dim("  · provider unreachable post-spam; restarting …"));
  await stopProvider(prov);
  prov = await startProvider();
}
// wait long enough for the rate-limit bucket to refill at least 1 token
await wait(2500);

// ─── STEP 7 ──────────────────────────────────────────────────────────
console.log(`\n${c.amber("▌ step 7")}  /api/v1/stats — anon 401, admin 200`);

const sa = await get("/api/v1/stats");
if (sa.status === 401) ok("anon → 401");
else ko(`anon got ${sa.status}`);

const auth = "Basic " + Buffer.from("admin:lumen-dev-secret").toString("base64");
const sb = await get("/api/v1/stats", { authorization: auth });
const jb = await sb.json();
if (sb.status === 200 && jb.totals?.total_requests > 0) ok(`admin → 200; total_requests=${jb.totals.total_requests}, sats_earned=${jb.totals.sats_earned ?? 0}`);
else ko(`admin got ${sb.status}: ${JSON.stringify(jb).slice(0, 200)}`);

// ─── teardown ─────────────────────────────────────────────────────────
await stopProvider(prov);

console.log("");
if (fail === 0) console.log(c.green(`PASS · ${pass}/${pass} checks`));
else            console.log(c.red(`FAIL · ${fail} of ${pass + fail} checks failed`));
process.exit(fail === 0 ? 0 : 1);
