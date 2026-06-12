import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { syncWmsStock } from "@/lib/services/wms-stock-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manually refresh the per-warehouse saleable-stock mirror from the WMS
 * Consolidated Stock report. Ops-facing trigger for when the cached stock is
 * stale (the cron also runs this on a schedule). Session-authenticated.
 */
export async function POST(req: NextRequest) {
  return handler("POST /api/wms/sync", async () => {
    await currentActor();
    const result = await syncWmsStock();
    if (!result.ok) return fail(result.error ?? "WMS sync failed", 502);
    return ok(result);
  });
}
