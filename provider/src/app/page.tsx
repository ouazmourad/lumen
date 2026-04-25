// Landing page for the LUMEN provider service.
// Reads its own config so the dashboard reflects the running server.

export const dynamic = "force-dynamic";

export default function Home() {
  const mode = process.env.MOCK_MODE === "true" ? "MOCK" : "REAL · NWC";
  const price = process.env.PRICE_SATS ?? "240";
  const ttl = process.env.INVOICE_TTL_SECONDS ?? "300";

  return (
    <main style={{
      minHeight: "100vh",
      background: "#0a0908",
      color: "#ece6d4",
      fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
      padding: "48px 32px",
      display: "flex", justifyContent: "center",
    }}>
      <div style={{ maxWidth: 920, width: "100%" }}>
        <header style={{ borderBottom: "1px solid #2d2a25", paddingBottom: 24, marginBottom: 32 }}>
          <div style={{ fontSize: 11, letterSpacing: ".22em", color: "#807968", textTransform: "uppercase" }}>
            LUMEN · provider · vision-oracle-3
          </div>
          <h1 style={{
            fontFamily: "ui-serif, Georgia, serif",
            fontWeight: 300, fontSize: 56, margin: "12px 0 0", letterSpacing: "-.02em",
          }}>
            <span style={{ color: "#ff9f1c" }}>402</span> Payment Required.
          </h1>
          <p style={{ marginTop: 16, color: "#c9c2ad", maxWidth: 600, lineHeight: 1.6 }}>
            This service sells on-demand listing verification for Lightning sats. Hit the endpoint without
            an <code style={{ color: "#5cf3ff" }}>Authorization</code> header to get an invoice.
          </p>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
          {[
            { l: "Wallet mode", v: mode, hot: mode === "MOCK" },
            { l: "Services",    v: "2" },
            { l: "Price / call", v: `${price} sat` },
            { l: "Invoice TTL", v: `${ttl} s` },
          ].map((s) => (
            <div key={s.l} style={{ border: "1px solid #2d2a25", padding: "16px 18px" }}>
              <div style={{ fontSize: 10, letterSpacing: ".18em", color: "#807968" }}>{s.l.toUpperCase()}</div>
              <div style={{ fontSize: 22, marginTop: 8, color: s.hot ? "#ff9f1c" : "#ece6d4" }}>{s.v}</div>
            </div>
          ))}
        </section>

        <section style={{ border: "1px solid #2d2a25", marginBottom: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid #2d2a25" }}>
            <div style={{ padding: "18px 22px", borderRight: "1px solid #2d2a25" }}>
              <div style={{ fontSize: 10, letterSpacing: ".22em", color: "#5cf3ff" }}>SERVICE 01 · VERIFICATION</div>
              <div style={{ fontFamily: "ui-serif, Georgia, serif", fontSize: 28, fontWeight: 300, marginTop: 8, color: "#ece6d4" }}>listing-verify</div>
              <div style={{ marginTop: 8, fontSize: 13, color: "#c9c2ad", lineHeight: 1.5 }}>OSM-geocoded ground truth. <span style={{ color: "#ff9f1c" }}>240 sat</span> · ~1.1 s</div>
              <div style={{ marginTop: 14, fontSize: 11, color: "#807968" }}>POST /api/v1/listing-verify</div>
            </div>
            <div style={{ padding: "18px 22px" }}>
              <div style={{ fontSize: 10, letterSpacing: ".22em", color: "#ff2d92" }}>SERVICE 02 · AUDIT</div>
              <div style={{ fontFamily: "ui-serif, Georgia, serif", fontSize: 28, fontWeight: 300, marginTop: 8, color: "#ece6d4" }}>order-receipt</div>
              <div style={{ marginTop: 8, fontSize: 13, color: "#c9c2ad", lineHeight: 1.5 }}>Signed delivery receipt. <span style={{ color: "#ff9f1c" }}>120 sat</span> · ~350 ms</div>
              <div style={{ marginTop: 14, fontSize: 11, color: "#807968" }}>POST /api/v1/order-receipt</div>
            </div>
          </div>
          <div style={{ padding: "12px 22px", fontSize: 11, color: "#807968", letterSpacing: ".06em", display: "flex", justifyContent: "space-between" }}>
            <span>Catalogue: <a href="/api/v1/discovery" style={{ color: "#5cf3ff" }}>GET /api/v1/discovery</a></span>
            <span>402index.io · agentic.market · ready to crawl</span>
          </div>
        </section>

        <section style={{ border: "1px solid #2d2a25", padding: 24, marginBottom: 24, background: "#13110e" }}>
          <div style={{ fontSize: 11, letterSpacing: ".18em", color: "#ff9f1c", marginBottom: 12 }}>TRY IT — POWERSHELL</div>
          <pre style={{ margin: 0, color: "#c9c2ad", fontSize: 13, lineHeight: 1.7, overflowX: "auto" }}>
{`# 1) Ask for the resource. You'll get 402 + an invoice.
$resp = curl.exe -i -X POST http://localhost:3000/api/v1/listing-verify \\
  -H "Content-Type: application/json" \\
  -d '{"listing":"hotel-larix-meribel","date":"2026-03-14"}'
$resp

# 2) In MOCK mode, "pay" by handing the script the preimage
#    via the dev helper at /api/dev/pay.  In REAL mode, your wallet
#    pays the bolt-11 invoice itself.

# 3) Replay with the L402 header to receive the verification.`}
          </pre>
        </section>

        <section style={{ border: "1px solid #2d2a25", padding: 24, background: "#13110e" }}>
          <div style={{ fontSize: 11, letterSpacing: ".18em", color: "#ff9f1c", marginBottom: 12 }}>EASIEST PATH — RUN THE BUYER</div>
          <pre style={{ margin: 0, color: "#c9c2ad", fontSize: 13, lineHeight: 1.7 }}>
{`cd ../buyer
node agent.js`}
          </pre>
          <p style={{ color: "#807968", fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
            The buyer script handles the 402 → pay → replay round-trip and prints the receipt.
          </p>
        </section>

        <footer style={{ marginTop: 40, color: "#807968", fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase" }}>
          GET <a href="/api/health" style={{ color: "#5cf3ff" }}>/api/health</a> · POST /api/v1/listing-verify
        </footer>
      </div>
    </main>
  );
}
