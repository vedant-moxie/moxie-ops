import { NextRequest, NextResponse } from "next/server";
import { resolveUnmappedSkus } from "@/lib/services/sku-item-mapper";

/**
 * POST /api/sku-mappings
 * Body: { skuIds: string[] }
 * Triggers AI mapping for unmapped SKUs, returns pending mappings for review.
 */
export async function POST(req: NextRequest) {
  try {
    const { skuIds } = (await req.json()) as { skuIds: string[] };
    if (!Array.isArray(skuIds) || skuIds.length === 0) {
      return NextResponse.json({ autoApplied: [], pendingMappings: [] });
    }
    const result = await resolveUnmappedSkus(skuIds);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/sku-mappings] POST error:", err);
    return NextResponse.json({ error: "Mapping failed" }, { status: 500 });
  }
}
