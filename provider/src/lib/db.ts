// ─────────────────────────────────────────────────────────────────────
//  Persistence — single-file SQLite via better-sqlite3.
//
//  Three tables that survive restart:
//    invoices  — every minted L402 challenge; transitions to consumed.
//    receipts  — paid order-receipts, replayable by id.
//    requests  — analytics + rate-limit observation.
//
//  Path: $LUMEN_DB_PATH (defaults to <repo-root>/lumen.db).
// ─────────────────────────────────────────────────────────────────────

import Database from "better-sqlite3";
import path from "node:path";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const file = process.env.LUMEN_DB_PATH ?? path.resolve(process.cwd(), "..", "lumen.db");
  _db = new Database(file);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  init(_db);
  return _db;
}

function init(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      payment_hash TEXT PRIMARY KEY,
      macaroon     TEXT NOT NULL,
      resource     TEXT NOT NULL,
      amount_sats  INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('pending','paid','expired','consumed')),
      preimage     TEXT,
      paid_at      INTEGER,
      consumed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at);

    CREATE TABLE IF NOT EXISTS receipts (
      receipt_id   TEXT PRIMARY KEY,
      claims_json  TEXT NOT NULL,
      signature    TEXT NOT NULL,
      order_id     TEXT NOT NULL,
      buyer        TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_order ON receipts(order_id);

    CREATE TABLE IF NOT EXISTS requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id    TEXT NOT NULL,
      ts            INTEGER NOT NULL,
      ip            TEXT,
      endpoint      TEXT NOT NULL,
      status        INTEGER NOT NULL,
      sats_charged  INTEGER NOT NULL DEFAULT 0,
      latency_ms    INTEGER NOT NULL,
      ua            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
    CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests(endpoint);
  `);
}

// ─── invoices ────────────────────────────────────────────────────────
export function recordInvoice(row: {
  payment_hash: string; macaroon: string; resource: string; amount_sats: number;
  created_at: number; expires_at: number;
}) {
  db().prepare(`
    INSERT OR IGNORE INTO invoices (payment_hash, macaroon, resource, amount_sats, created_at, expires_at, status)
    VALUES (@payment_hash, @macaroon, @resource, @amount_sats, @created_at, @expires_at, 'pending')
  `).run(row);
}

export function lookupInvoiceRow(payment_hash: string): {
  status: string; consumed_at: number | null; resource: string; amount_sats: number;
} | undefined {
  return db().prepare(
    `SELECT status, consumed_at, resource, amount_sats FROM invoices WHERE payment_hash = ?`,
  ).get(payment_hash) as { status: string; consumed_at: number | null; resource: string; amount_sats: number } | undefined;
}

export function markInvoiceConsumed(payment_hash: string, preimage: string): boolean {
  // single-use: only flips pending|paid -> consumed.
  const r = db().prepare(`
    UPDATE invoices
       SET status = 'consumed', preimage = ?, paid_at = COALESCE(paid_at, ?), consumed_at = ?
     WHERE payment_hash = ? AND status IN ('pending','paid')
  `).run(preimage, Date.now(), Date.now(), payment_hash);
  return r.changes === 1;
}

// ─── receipts ────────────────────────────────────────────────────────
export function recordReceipt(row: {
  receipt_id: string; claims_json: string; signature: string;
  order_id: string; buyer: string | null;
}) {
  db().prepare(`
    INSERT INTO receipts (receipt_id, claims_json, signature, order_id, buyer, created_at)
    VALUES (@receipt_id, @claims_json, @signature, @order_id, @buyer, @created_at)
  `).run({ ...row, created_at: Date.now() });
}

export function getReceipt(receipt_id: string): {
  receipt_id: string; claims_json: string; signature: string; created_at: number;
} | undefined {
  return db().prepare(
    `SELECT receipt_id, claims_json, signature, created_at FROM receipts WHERE receipt_id = ?`,
  ).get(receipt_id) as { receipt_id: string; claims_json: string; signature: string; created_at: number } | undefined;
}

// ─── requests / stats ────────────────────────────────────────────────
export function recordRequest(row: {
  request_id: string; ip: string | null; endpoint: string; status: number;
  sats_charged: number; latency_ms: number; ua: string | null;
}) {
  db().prepare(`
    INSERT INTO requests (request_id, ts, ip, endpoint, status, sats_charged, latency_ms, ua)
    VALUES (@request_id, @ts, @ip, @endpoint, @status, @sats_charged, @latency_ms, @ua)
  `).run({ ...row, ts: Date.now() });
}

export function aggregateStats() {
  const d = db();
  const totals = d.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN status = 402 THEN 1 ELSE 0 END) AS challenges,
      SUM(CASE WHEN status = 401 THEN 1 ELSE 0 END) AS unauthorized,
      SUM(CASE WHEN status = 409 THEN 1 ELSE 0 END) AS replays_blocked,
      SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS rate_limited,
      SUM(sats_charged) AS sats_earned
    FROM requests
  `).get() as Record<string, number>;

  const byEndpoint = d.prepare(`
    SELECT endpoint,
           COUNT(*) AS n,
           SUM(sats_charged) AS sats,
           AVG(latency_ms) AS p_avg_ms
      FROM requests
     GROUP BY endpoint
     ORDER BY n DESC
  `).all() as { endpoint: string; n: number; sats: number; p_avg_ms: number }[];

  const invoices = d.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'consumed' THEN 1 ELSE 0 END) AS consumed,
      SUM(CASE WHEN status = 'expired'  THEN 1 ELSE 0 END) AS expired,
      COUNT(*) AS total
    FROM invoices
  `).get() as Record<string, number>;

  const receipts = d.prepare(`SELECT COUNT(*) AS n FROM receipts`).get() as { n: number };

  return { totals, byEndpoint, invoices, receipts: receipts.n };
}
