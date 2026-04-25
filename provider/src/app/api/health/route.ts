import { wallet } from "@/lib/wallet";

export async function GET() {
  return Response.json({
    ok: true,
    service: "lumen-provider",
    wallet_mode: wallet().kind,
    price_sats: parseInt(process.env.PRICE_SATS ?? "240", 10),
    endpoints: ["POST /v1/listing-verify"],
  });
}
