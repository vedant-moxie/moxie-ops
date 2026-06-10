import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { syncWmsStock, isWmsStockStale } from "@/lib/services/wms-stock-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Mirrors per-warehouse saleable stock from the WMS Consolidated Stock report.
 * ?ifStale=1 → skip when the mirror is fresher than WMS_STOCK_STALE_MINUTES.
 */
export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  if (new URL(req.url).searchParams.get("ifStale") === "1" && !(await isWmsStockStale())) {
    return NextResponse.json({ success: true, skipped: "fresh" });
  }

  try {
    const result = await syncWmsStock();
    return NextResponse.json({ success: result.ok, ...result }, { status: result.ok ? 200 : 502 });
  } catch (err) {
    console.error("[cron/wms-stock-sync]", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
