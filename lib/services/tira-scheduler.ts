import { env } from "@/lib/env";

// Persist the timer across HMR / re-imports in dev.
const g = globalThis as unknown as { __tiraDaily?: NodeJS.Timeout };

const IST_OFFSET_MS = 5.5 * 3_600_000;
const SYNC_HOUR_IST = 9; // 09:00 IST — off-hours, so the SAP single-session login won't fight a human.

/**
 * Hit the unattended cron endpoint on our own server (over HTTP, so this module
 * stays free of the Node-only Playwright dep that can't bundle into Next's
 * instrumentation). We force a full scrape (not ifStale) — at 9 AM we always
 * want a fresh pull.
 */
async function triggerSync(): Promise<void> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const url = `${base}/api/cron/tira-sync`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { fetched?: number }; error?: string };
    console.log(`[tira:auto] 09:00 IST sync ${res.ok ? "ok" : "failed"} (${res.status})`, json.data?.fetched ?? json.error ?? "");
  } catch (e) {
    console.error("[tira:auto] trigger failed:", e instanceof Error ? e.message : e);
  }
}

/** Milliseconds from now until the next HH:00 IST. */
function msUntilNextIstHour(hour: number): number {
  const nowShifted = Date.now() + IST_OFFSET_MS; // shift into IST wall-clock space
  const next = new Date(nowShifted);
  next.setUTCHours(hour, 0, 0, 0); // operate on the shifted clock as if it were UTC
  if (next.getTime() <= nowShifted) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - nowShifted; // a pure duration — timezone-agnostic
}

/**
 * Start the background Tira auto-sync: a headless-browser scrape once a day at
 * 09:00 IST. Idempotent (guards against HMR/double registration). Disabled when
 * TIRA_AUTO_SYNC=false. No startup catch-up — we only ever run at 9 AM so the
 * automated SAP login never collides with someone using the portal in the day.
 */
export function startTiraAutoSync(): void {
  if (env.TIRA_AUTO_SYNC === "false") {
    console.log("[tira:auto] disabled (TIRA_AUTO_SYNC=false)");
    return;
  }
  if (g.__tiraDaily) return;

  const schedule = () => {
    const delay = msUntilNextIstHour(SYNC_HOUR_IST);
    g.__tiraDaily = setTimeout(() => {
      void triggerSync();
      schedule(); // re-arm for the next day
    }, delay);
    if (typeof g.__tiraDaily.unref === "function") g.__tiraDaily.unref();
    console.log(`[tira:auto] next scrape in ~${(delay / 3_600_000).toFixed(1)}h (09:00 IST daily)`);
  };
  schedule();
}
