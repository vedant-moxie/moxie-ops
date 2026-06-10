import { NextRequest, NextResponse } from "next/server";
import { readWarehouseStock } from "@/lib/services/wms-stock-sync";

export const dynamic = "force-dynamic";

/**
 * GET /api/inventory/warehouses?skus=id1,id2,...
 * Returns per-warehouse free saleable stock (live WMS mirror) for the SKU IDs.
 */
export async function GET(req: NextRequest) {
  try {
    const skusParam = req.nextUrl.searchParams.get("skus") ?? "";
    const skuIds = skusParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (!skuIds.length) return NextResponse.json({});
    const data = await readWarehouseStock(skuIds);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/inventory/warehouses]", err);
    return NextResponse.json({}, { status: 500 });
  }
}
