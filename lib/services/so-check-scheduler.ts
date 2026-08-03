import { env } from "@/lib/env";

// Persist a single timer across HMR / re-imports in dev.
const g = globalThis as unknown as { __soCheckTimer?: NodeJS.Timeout };

/** IST working hours — the SO punch only happens while the WH team is in. */
const IST_OFFSET_MS = 5.5 * 3_600_000;
function withinWorkingHours(now = new Date()): boolean {
  const h = new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
  return h >= 9 && h < 21;
}

/**
 * The hour (IST) at which the daily pass also pulls the Outward LOI Report for SKU
 * quantities — late enough that the day's dispatches are in, and that report only
 * shows dispatched SOs.
 */
const LINES_PASS_IST_HOUR = 20;

function istHour(now = new Date()): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** Hit our own cron endpoint over HTTP, same as the WMS stock scheduler. */
async function trigger(): Promise<void> {
  if (!withinWorkingHours()) return;
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  // Once a day, also fetch line quantities (switches the portal warehouse per
  // warehouse and restores it, so it must not run hourly).
  const lines = istHour() === LINES_PASS_IST_HOUR ? "?lines=1" : "";
  try {
    const res = await fetch(`${base}/api/cron/so-verification${lines}`, {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as {
      salesOrders?: number;
      posChecked?: number;
      flagged?: number;
      error?: string;
    };
    if (json.error) console.log(`[so-check:auto] skipped — ${json.error}`);
    else
      console.log(
        `[so-check:auto] ${json.salesOrders ?? 0} SOs, ${json.posChecked ?? 0} POs, ${json.flagged ?? 0} flagged`,
      );
  } catch (e) {
    console.error("[so-check:auto] trigger failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start the background SO-entry check. Idempotent (guards against HMR/double
 * registration). Runs every SO_CHECK_INTERVAL_HOURS (default 1h) during IST
 * working hours, plus one startup run.
 */
export function startSoCheckAutoRun(): void {
  if (env.SO_CHECK_AUTO === "false") {
    console.log("[so-check:auto] disabled (SO_CHECK_AUTO=false)");
    return;
  }
  if (!env.WMS_EMAIL || !env.WMS_PASSWORD) {
    console.log("[so-check:auto] disabled — WMS_EMAIL / WMS_PASSWORD not set");
    return;
  }
  if (g.__soCheckTimer) return;
  const hours = env.SO_CHECK_INTERVAL_HOURS;

  g.__soCheckTimer = setInterval(() => void trigger(), hours * 3_600_000);
  if (typeof g.__soCheckTimer.unref === "function") g.__soCheckTimer.unref();
  console.log(`[so-check:auto] scheduled every ${hours}h (09:00–21:00 IST)`);

  setTimeout(() => void trigger(), 15_000);
}
