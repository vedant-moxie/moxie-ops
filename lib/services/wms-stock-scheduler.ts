import { env } from "@/lib/env";

// Persist a single timer across HMR / re-imports in dev.
const g = globalThis as unknown as { __wmsStockTimer?: NodeJS.Timeout };

/**
 * Hit the unattended WMS stock cron endpoint on our own server. We go over HTTP
 * (rather than importing the sync code) so this module stays free of Node-only
 * deps that can't be bundled into Next's instrumentation.
 */
async function triggerSync(ifStale: boolean): Promise<void> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const url = `${base}/api/cron/wms-stock-sync${ifStale ? "?ifStale=1" : ""}`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      skipped?: string;
      rows?: number;
      warehouses?: string[];
    };
    if (json.skipped) console.log("[wms:auto] stock fresh — skipped");
    else
      console.log(
        `[wms:auto] sync ${res.ok ? "ok" : "failed"} (${res.status})`,
        json.rows != null ? `${json.rows} rows / ${json.warehouses?.length ?? 0} wh` : "",
      );
  } catch (e) {
    console.error("[wms:auto] trigger failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start the background WMS stock auto-sync. Idempotent (guards against HMR/double
 * registration). Re-pulls the Consolidated MIS stock report every
 * WMS_SYNC_INTERVAL_HOURS (default 3h), plus a startup catch-up that only runs
 * if the mirror is already older than WMS_STOCK_STALE_MINUTES.
 */
export function startWmsStockAutoSync(): void {
  if (env.WMS_AUTO_SYNC === "false") {
    console.log("[wms:auto] disabled (WMS_AUTO_SYNC=false)");
    return;
  }
  if (!env.WMS_EMAIL || !env.WMS_PASSWORD) {
    console.log("[wms:auto] disabled — WMS_EMAIL / WMS_PASSWORD not set");
    return;
  }
  if (g.__wmsStockTimer) return;
  const hours = env.WMS_SYNC_INTERVAL_HOURS;
  const intervalMs = hours * 3_600_000;

  g.__wmsStockTimer = setInterval(() => void triggerSync(false), intervalMs);
  if (typeof g.__wmsStockTimer.unref === "function") g.__wmsStockTimer.unref();
  console.log(`[wms:auto] scheduled every ${hours}h`);

  // Startup catch-up (server needs a moment to start listening).
  setTimeout(() => void triggerSync(true), 12_000);
}
