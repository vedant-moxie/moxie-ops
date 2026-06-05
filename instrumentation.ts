/**
 * Next.js instrumentation — runs once when the server process boots.
 * We use it to start the background Blinkit auto-sync (every 3h by default).
 * Guarded to the Node.js runtime so it never runs in the edge/middleware bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startBlinkitAutoSync } = await import("@/lib/services/blinkit-scheduler");
    startBlinkitAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start Blinkit auto-sync", e);
  }
  try {
    const { startInstamartAutoSync } = await import("@/lib/services/instamart-scheduler");
    startInstamartAutoSync();
  } catch (e) {
    console.error("[instrumentation] failed to start Instamart auto-sync", e);
  }
}
