import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { syncTira } from "@/lib/services/tira-sync";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Unattended Tira sync: drives a real headless browser through the SAP SSO
 * login, scrapes the PO list, and upserts. Reliance SRM allows ~one session per
 * user, so this runs serially (no concurrent triggers) and logs off afterwards.
 */
export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  // ?ifStale=1 → only sync when the latest Tira PO is older than the interval.
  if (new URL(req.url).searchParams.get("ifStale") === "1") {
    const latest = await prisma.purchaseOrder.findFirst({
      where: { source: "TIRA" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    const ageMs = latest ? Date.now() - latest.updatedAt.getTime() : Infinity;
    if (ageMs < env.TIRA_SYNC_INTERVAL_HOURS * 3_600_000) {
      return NextResponse.json({ success: true, data: { skipped: true, reason: "fresh" } });
    }
  }

  console.log("[cron:tira-sync] starting");
  try {
    const result = await syncTira({ actorLabel: "Tira cron" });
    console.log("[cron:tira-sync] done", { fetched: result.fetched, created: result.created, updated: result.updated });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[cron:tira-sync]", error);
    await sendWhatsAppAlert(
      `🚨 Cron failure: tira-sync — ${error instanceof Error ? error.message : "unknown"}`,
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
