/**
 * Next.js instrumentation — runs once when the server process boots.
 * We use it to start the background channel auto-syncs (Blinkit / Zepto /
 * Instamart / Nykaa) and the WMS stock auto-sync — every 3h by default each.
 * Guarded to the Node.js runtime so it never runs in the edge/middleware bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Load the editable SKU master from the DB so resolution + taxable checks
    // use live data (falls back to the generated file when the table is empty).
    const { refreshSkuMasterCache } = await import("@/lib/services/sku-master");
    const n = await refreshSkuMasterCache();
    console.info(`[instrumentation] SKU master cache warmed (${n} DB rows)`);
  } catch (e) {
    console.error("[instrumentation] failed to warm SKU master cache", e);
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
