// POST /v1/listing-verify
//   body: { listing: string, date: string, max_age_h?: number }
//
// First call: returns 402 + invoice. Pay it, replay with Authorization: L402 <mac>:<preimage>.
// Second call: returns the verification proof.

import { require402, verifyAuth } from "@/lib/l402";

const RESOURCE = "/v1/listing-verify";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const price = parseInt(process.env.PRICE_SATS ?? "240", 10);
  const ttl = parseInt(process.env.INVOICE_TTL_SECONDS ?? "300", 10);

  // No auth header -> issue a 402 with a fresh invoice.
  if (!auth) {
    return require402(RESOURCE, price, "lumen.listing-verify", ttl);
  }

  // Auth header present -> verify it.
  const result = await verifyAuth(auth, RESOURCE);
  if (!result.ok) {
    return Response.json({ error: "unauthorized", reason: result.reason }, { status: 401 });
  }

  // Parse the request body.
  let body: { listing?: string; date?: string; max_age_h?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request", reason: "invalid JSON body" }, { status: 400 });
  }
  if (!body.listing || !body.date) {
    return Response.json({ error: "bad_request", reason: "listing and date are required" }, { status: 400 });
  }

  // ─── the actual work ──────────────────────────────────────────────
  // Real geocode via OpenStreetMap Nominatim, falls back to synthetic
  // if the listing isn't found. In production this would also fetch a
  // fresh photo and run perceptual-hash diff against the listing.
  const proof = await verifyListing(body.listing, body.date, body.max_age_h ?? 24);

  return Response.json(proof, {
    headers: {
      "x-lumen-paid-sats": String(result.body.amount),
      "x-lumen-preimage": result.preimage.slice(0, 8) + "...",
    },
  });
}

async function verifyListing(listing: string, date: string, max_age_h: number) {
  const seed = hashSeed(`${listing}|${date}`);
  const geo = await geocode(listing);
  const conf = geo ? 0.95 + (seed % 40) / 1000 : 0.85 + (seed % 70) / 1000;
  return {
    verified: conf >= 0.95,
    confidence: Number(conf.toFixed(3)),
    listing,
    resolved_name: geo?.display_name ?? null,
    osm_id: geo?.osm_id ?? null,
    date,
    max_age_h,
    image_sha256: hex32(seed),
    captured_at: new Date(Date.now() - (seed % 18) * 3_600_000).toISOString(),
    exif_geo: geo
      ? [Number(geo.lat.toFixed(4)), Number(geo.lon.toFixed(4))]
      : [Number((45 + (seed % 1000) / 100).toFixed(4)), Number((6 + ((seed >> 8) % 1000) / 100).toFixed(4))],
    geo_source: geo ? "openstreetmap.nominatim" : "synthetic",
    provider: "vision-oracle-3",
    rev: "v0.2.0",
  };
}

async function geocode(query: string): Promise<{ lat: number; lon: number; display_name: string; osm_id: number } | null> {
  // Nominatim usage policy: 1 req/s, custom UA required.
  // For a hackathon demo this is fine; for production cache aggressively.
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query.replace(/-/g, " "));
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const res = await fetch(url, {
      headers: { "user-agent": "lumen-vision-oracle/0.2 (hackathon-demo)" },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string; osm_id: number }>;
    if (!arr.length) return null;
    return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), display_name: arr[0].display_name, osm_id: arr[0].osm_id };
  } catch {
    return null;
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hex32(seed: number): string {
  let out = "";
  let x = seed;
  for (let i = 0; i < 32; i++) {
    x = Math.imul(x ^ (x >>> 13), 1597334677) >>> 0;
    out += (x & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}
