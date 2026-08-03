import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { verifySalesOrders } from "@/lib/services/so-verification";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Verifies the manually-punched WMS sales orders against our approved POs (plan 008).
 * Idempotent — a run that can't read SOs leaves every mirror and flag untouched rather
 * than clearing them.
 *
 * ?lines=1 → also pull the Outward LOI Report for SKU quantities. That report is
 * dispatch-driven and its warehouse parameter is disabled, so the fetch switches the
 * portal's selected warehouse per warehouse and restores it after. Run it DAILY, not
 * hourly.
 */
export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  const withLines = new URL(req.url).searchParams.get("lines") === "1";

  try {
    const result = await verifySalesOrders({ withLines });
    return NextResponse.json({ success: result.ok, ...result }, { status: result.ok ? 200 : 502 });
  } catch (err) {
    console.error("[cron/so-verification]", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
