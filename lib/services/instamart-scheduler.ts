import { env } from "@/lib/env";

// Persist a single timer across HMR / re-imports in dev.
const g = globalThis as unknown as { __instamartTimer?: NodeJS.Timeout };

/**
 * Hit the unattended cron endpoint on our own server. We go over HTTP (rather
 * than importing the sync code) so this module stays free of Node-only deps
 * (imapflow) that can't be bundled into Next's instrumentation.
 */
async function triggerSync(ifStale: boolean): Promise<void> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const url = `${base}/api/cron/instamart-sync${ifStale ? "?ifStale=1" : ""}`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { skipped?: boolean; summary?: { posUpserted?: number } } };
    if (json.data?.skipped) console.log("[instamart:auto] data fresh — skipped");
    else console.log(`[instamart:auto] sync ${res.ok ? "ok" : "failed"} (${res.status})`, json.data?.summary?.posUpserted ?? "");
  } catch (e) {
    console.error("[instamart:auto] trigger failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start the background Instamart auto-sync. Idempotent (guards against HMR/double
 * registration). Re-scrapes every INSTAMART_SYNC_INTERVAL_HOURS, plus a startup
 * catch-up that only runs if the data is already older than that window.
 */
export function startInstamartAutoSync(): void {
  if (env.INSTAMART_AUTO_SYNC === "false") {
    console.log("[instamart:auto] disabled (INSTAMART_AUTO_SYNC=false)");
    return;
  }
  if (g.__instamartTimer) return;
  const hours = env.INSTAMART_SYNC_INTERVAL_HOURS;
  const intervalMs = hours * 3_600_000;

  g.__instamartTimer = setInterval(() => void triggerSync(false), intervalMs);
  if (typeof g.__instamartTimer.unref === "function") g.__instamartTimer.unref();
  console.log(`[instamart:auto] scheduled every ${hours}h`);

  // Startup catch-up (server needs a moment to start listening).
  setTimeout(() => void triggerSync(true), 14_000);
}
