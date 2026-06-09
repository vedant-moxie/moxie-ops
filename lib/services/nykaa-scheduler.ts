import { env } from "@/lib/env";

// Persist a single timer across HMR / re-imports in dev.
const g = globalThis as unknown as { __nykaaTimer?: NodeJS.Timeout };

/**
 * Hit the unattended cron endpoint on our own server. We go over HTTP (rather
 * than importing the sync code) so this module stays free of Node-only deps
 * (imapflow) that can't be bundled into Next's instrumentation.
 */
async function triggerSync(ifStale: boolean): Promise<void> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const url = `${base}/api/cron/nykaa-sync${ifStale ? "?ifStale=1" : ""}`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { skipped?: boolean; summary?: { posUpserted?: number } };
    };
    if (json.data?.skipped) console.log("[nykaa:auto] data fresh — skipped");
    else console.log(`[nykaa:auto] sync ${res.ok ? "ok" : "failed"} (${res.status})`, json.data?.summary?.posUpserted ?? "");
  } catch (e) {
    console.error("[nykaa:auto] trigger failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start the background Nykaa auto-sync. Idempotent (guards against HMR/double
 * registration). Disabled by default (NYKAA_AUTO_SYNC defaults to "false") until
 * Nykaa creds are configured (TWOCAPTCHA_API_KEY + login/OTP, or a portal token) —
 * otherwise every tick would fail at login. Set NYKAA_AUTO_SYNC=true once creds
 * are set. Re-scrapes every NYKAA_SYNC_INTERVAL_HOURS, plus a startup catch-up
 * that only runs if the data is already older than that window.
 */
export function startNykaaAutoSync(): void {
  if (env.NYKAA_AUTO_SYNC !== "true") {
    console.log("[nykaa:auto] disabled (set NYKAA_AUTO_SYNC=true once Nykaa creds are configured)");
    return;
  }
  if (g.__nykaaTimer) return;
  const hours = env.NYKAA_SYNC_INTERVAL_HOURS;
  const intervalMs = hours * 3_600_000;

  g.__nykaaTimer = setInterval(() => void triggerSync(false), intervalMs);
  if (typeof g.__nykaaTimer.unref === "function") g.__nykaaTimer.unref();
  console.log(`[nykaa:auto] scheduled every ${hours}h`);

  // Startup catch-up (server needs a moment to start listening).
  setTimeout(() => void triggerSync(true), 14_000);
}
