import { NextRequest, NextResponse } from "next/server";
import { confirmSkuMapping, dismissSkuMapping } from "@/lib/services/sku-item-mapper";

/**
 * POST /api/sku-mappings/confirm
 * Body: { skuId, wmsCode } — confirm a specific mapping (user-chosen or AI-suggested)
 *
 * DELETE /api/sku-mappings/confirm
 * Body: { skuId } — dismiss a mapping (no WMS stock for this SKU)
 */
export async function POST(req: NextRequest) {
  try {
    const { skuId, wmsCode } = (await req.json()) as { skuId: string; wmsCode: string };
    if (!skuId || !wmsCode) return NextResponse.json({ error: "skuId and wmsCode required" }, { status: 400 });
    await confirmSkuMapping(skuId, wmsCode);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/sku-mappings/confirm] POST error:", err);
    return NextResponse.json({ error: "Confirm failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { skuId } = (await req.json()) as { skuId: string };
    if (!skuId) return NextResponse.json({ error: "skuId required" }, { status: 400 });
    await dismissSkuMapping(skuId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/sku-mappings/confirm] DELETE error:", err);
    return NextResponse.json({ error: "Dismiss failed" }, { status: 500 });
  }
}
