import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { ingestTiraPayload } from "@/lib/services/tira-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Accept arbitrary raw objects from the browser collector. The extractor in
// tira-sync handles the field-name variation, so we don't over-constrain here.
const bodySchema = z.object({
  pos: z.array(z.record(z.unknown())).default([]),
  // Each PO's items value is a wrapper object (purchaseOrderItems lives inside);
  // accept arbitrary values and let the service unwrap it.
  items: z.record(z.unknown()).optional(),
});

/**
 * POST /api/tira/ingest
 *
 * Receives a browser-collected Tira payload (PO list + per-PO line items) and
 * ingests it. CORS-open so the collector snippet running on srm-rrscm.ril.com
 * can POST cross-origin to localhost.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
};

export async function POST(req: NextRequest) {
  const res = await handler("POST /api/tira/ingest", async () => {
    const body = bodySchema.parse(await req.json());
    const result = await ingestTiraPayload(body);
    return ok(result);
  });
  // Attach CORS to every response (incl. errors) so the cross-origin collector
  // sees the real status instead of a generic CORS failure.
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
