import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { syncBlinkit } from "@/lib/services/blinkit-sync";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";
import { keepChannelTokenWarm } from "@/lib/services/token-refresh";
import { getTokensIfCached, getTokens } from "@/lib/integrations/blinkit/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Real-time-ish Blinkit sync: re-pulls POs since the backfill floor and upserts. */
export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  // ?ifStale=1 → only sync when the latest Blinkit PO is older than the interval.
  if (new URL(req.url).searchParams.get("ifStale") === "1") {
    const latest = await prisma.purchaseOrder.findFirst({
      where: { source: "BLINKIT" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    const ageMs = latest ? Date.now() - latest.updatedAt.getTime() : Infinity;
    if (ageMs < env.BLINKIT_SYNC_INTERVAL_HOURS * 3_600_000) {
      // Data is fresh so we skip the pull, but keep the token warm if it's near
      // expiry so doc downloads in the allocate hot path rarely hit the 401 path.
      const token = await keepChannelTokenWarm({
        channel: "blinkit",
        getCached: getTokensIfCached,
        refresh: () => getTokens(true),
      });
      return NextResponse.json({ success: true, data: { skipped: true, reason: "fresh", token } });
    }
  }

  console.log("[cron:blinkit-sync] starting");
  try {
    const result = await syncBlinkit({ actorLabel: "Blinkit cron" });
    console.log("[cron:blinkit-sync] done", {
      pos: result.summary.posUpserted,
      lines: result.summary.lineItems,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[cron:blinkit-sync]", error);
    await sendWhatsAppAlert(
      `🚨 Cron failure: blinkit-sync — ${error instanceof Error ? error.message : "unknown"}`,
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
