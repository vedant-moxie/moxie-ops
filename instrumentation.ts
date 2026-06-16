/**
 * Next.js instrumentation — runs once when the server process boots.
 * We use it to start the background channel auto-syncs (Blinkit / Zepto /
 * Instamart / Nykaa) and the WMS stock auto-sync — every 3h by default each.
 * Guarded to the Node.js runtime so it never runs in the edge/middleware bundle.
 *
 * Scheduling model depends on the host:
 *  - Self-hosted / Docker (one long-running process): the in-process setInterval
 *    timers below drive the syncs. Run a SINGLE app instance or they double-fire.
 *  - Vercel (serverless, no persistent process): these timers can't survive, so
 *    they're skipped (process.env.VERCEL is set). Scheduling is done by Vercel
 *    Cron (see vercel.json) hitting the /api/cron/*-sync routes instead.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Load the editable SKU master from the DB so resolution + taxable checks
    // use live data (falls back to the generated file when the table is empty).
    // Runs on every cold start (incl. Vercel) so each instance has live maps.
    const { refreshSkuMasterCache } = await import("@/lib/services/sku-master");
    const n = await refreshSkuMasterCache();
    console.info(`[instrumentation] SKU master cache warmed (${n} DB rows)`);
  } catch (e) {
    console.error("[instrumentation] failed to warm SKU master cache", e);
  }

  // On Vercel, scheduling is handled by Vercel Cron (vercel.json), not in-process
  // timers — skip them so they neither waste cycles nor double-fire across instances.
  if (process.env.VERCEL) {
    console.info("[instrumentation] Vercel detected — in-process schedulers disabled (using Vercel Cron)");
    return;
  }

  try {
    const { startBlinkitAutoSync } = await import("@/lib/services/blinkit-scheduler");
    startBlinkitAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start Blinkit auto-sync", e);
  }
  try {
    const { startZeptoAutoSync } = await import("@/lib/services/zepto-scheduler");
    startZeptoAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start Zepto auto-sync", e);
  }
  try {
    const { startInstamartAutoSync } = await import("@/lib/services/instamart-scheduler");
    startInstamartAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start Instamart auto-sync", e);
  }
  try {
    const { startNykaaAutoSync } = await import("@/lib/services/nykaa-scheduler");
    startNykaaAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start Nykaa auto-sync", e);
  }
  try {
    const { startTiraAutoSync } = await import("@/lib/services/tira-scheduler");
    startTiraAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start Tira auto-sync", e);
  }
  try {
    const { startWmsStockAutoSync } = await import("@/lib/services/wms-stock-scheduler");
    startWmsStockAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start WMS stock auto-sync", e);
  }
}
