// ─────────────────────────────────────────────────────────────────────
//  Preflight — validates both .env files and both NWC connections
//  WITHOUT spending a sat. Run this before `npm run demo` to catch:
//
//    • mistyped / swapped NWC strings
//    • missing permissions (provider needs make_invoice; buyer needs pay_invoice)
//    • unreachable relays
//    • L402_SECRET too short
//    • MOCK_MODE inconsistent across the two apps
//
//  Run:  npm run preflight
// ─────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NWCClient } from "@getalby/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// ─── tiny console helpers ────────────────────────────────────────────
const c = {
  amber: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[38;5;87m${s}\x1b[0m`,
  green: (s) => `\x1b[38;5;120m${s}\x1b[0m`,
  red:   (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  dim:   (s) => `\x1b[38;5;245m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
};
const ok   = (m) => console.log(`  ${c.green("✓")} ${m}`);
const warn = (m) => console.log(`  ${c.amber("!")} ${m}`);
const fail = (m) => { console.log(`  ${c.red("✗")} ${m}`); failures++; };
const info = (m) => console.log(`  ${c.dim("·")} ${c.dim(m)}`);
let failures = 0;

// ─── tiny .env parser (no dep) ───────────────────────────────────────
function parseEnv(file) {
  if (!fs.existsSync(file)) return null;
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// ─── per-side check ──────────────────────────────────────────────────
async function checkSide(label, role, envFile, requiredMethods) {
  console.log(`\n${c.bold(c.amber(`▌ ${label}`))}  ${c.dim(envFile.replace(root + path.sep, ""))}`);
  const env = parseEnv(envFile);
  if (!env) { fail(`${envFile} not found`); return null; }

  // env hygiene
  if (env.MOCK_MODE === "true") warn(`MOCK_MODE=true — Lightning will not be used for this side`);
  else                          ok  (`MOCK_MODE=false`);
  if (role === "provider" && (env.L402_SECRET?.length ?? 0) < 32) fail(`L402_SECRET must be ≥32 chars`);
  if (role === "provider")    ok  (`L402_SECRET length ${env.L402_SECRET.length}`);

  if (!env.NWC_URL || !env.NWC_URL.startsWith("nostr+walletconnect://")) {
    fail(`NWC_URL missing or not a nostr+walletconnect:// string`);
    return null;
  }
  ok(`NWC_URL parses`);

  // connect, getInfo, getBalance — all free queries
  let client;
  try {
    client = new NWCClient({ nostrWalletConnectUrl: env.NWC_URL });
  } catch (e) { fail(`NWCClient init failed: ${e.message}`); return null; }
  info(`connecting to ${client.relayUrls[0]} …`);

  let infoRes;
  try {
    infoRes = await Promise.race([
      client.getInfo(),
      new Promise((_, r) => setTimeout(() => r(new Error("relay timeout 8s")), 8000)),
    ]);
    ok(`getInfo OK · ${infoRes.alias || "(no alias)"} · ${infoRes.network || "?"} · block ${infoRes.block_height ?? "?"}`);
  } catch (e) { fail(`getInfo failed: ${e.message}`); client.close(); return null; }

  // permission check
  const have = new Set(infoRes.methods || []);
  const missing = requiredMethods.filter((m) => !have.has(m));
  if (missing.length) fail(`missing required permissions: ${missing.join(", ")}`);
  else                ok  (`permissions: ${requiredMethods.join(" + ")}`);

  // balance — for context only; NOT a hard fail
  try {
    const bal = await client.getBalance();
    const sats = Math.round((bal.balance ?? 0) / 1000);
    const usd = (sats * 0.00067).toFixed(2);
    if (role === "buyer") {
      if (sats < 250) warn(`balance ${sats} sat (~$${usd}) — not enough for one demo run; top up the buyer wallet`);
      else            ok  (`balance ${sats} sat (~$${usd}) — enough for ${Math.floor(sats / 240)} demo runs`);
    } else {
      ok  (`balance ${sats} sat (~$${usd})`);
      if (sats < 1) info(`provider balance is 0 — that's fine; Alby Cloud auto-opens inbound channel on first incoming payment`);
    }
  } catch (e) { warn(`getBalance failed: ${e.message}`); }

  client.close();
  return { env, info: infoRes };
}

// ─── cross-checks between the two sides ──────────────────────────────
function crossCheck(p, b) {
  console.log(`\n${c.bold(c.amber("▌ cross-check"))}`);
  if (!p || !b) { fail("one or both sides did not validate; cannot cross-check"); return; }

  const ppub = new URL(p.env.NWC_URL).host;
  const bpub = new URL(b.env.NWC_URL).host;
  if (ppub === bpub) {
    fail(`provider and buyer share the SAME wallet pubkey (${ppub.slice(0, 12)}…). Lightning will only show a self-payment — judges won't see money move. Create a SECOND Alby app and use a different NWC string for one of them.`);
  } else {
    ok(`distinct wallet pubkeys  ${c.dim(`provider=${ppub.slice(0, 8)}…  buyer=${bpub.slice(0, 8)}…`)}`);
  }
  if (p.env.MOCK_MODE !== b.env.MOCK_MODE) {
    fail(`MOCK_MODE differs across the two env files (provider=${p.env.MOCK_MODE} buyer=${b.env.MOCK_MODE}); both must be the same`);
  } else {
    ok(`MOCK_MODE matches on both sides (${p.env.MOCK_MODE})`);
  }
}

// ─── go ──────────────────────────────────────────────────────────────
console.log(c.bold(c.amber("LUMEN preflight")));
console.log(c.dim("checks both NWC connections without sending sats."));

const provider = await checkSide("provider", "provider", path.join(root, "provider", ".env.local"), ["make_invoice", "lookup_invoice"]);
const buyer    = await checkSide("buyer",    "buyer",    path.join(root, "buyer",    ".env"),       ["pay_invoice"]);
crossCheck(provider, buyer);

console.log("");
if (failures === 0) console.log(c.green("READY — `npm run demo` should settle on real Lightning."));
else                console.log(c.red(`${failures} issue${failures > 1 ? "s" : ""} above. Fix and re-run \`npm run preflight\`.`));
process.exit(failures === 0 ? 0 : 1);
