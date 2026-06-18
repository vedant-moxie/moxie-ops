import { NextRequest } from "next/server";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getLiveAtp } from "@/lib/services/live-atp";

export const dynamic = "force-dynamic";

/** Live ATP rows for the dashboard sidebar: master-deduped, ranked by today's demand. */
export async function GET(req: NextRequest) {
  return handler("GET /api/dashboard/live-atp", async () => {
    await requireAuth();
    const force = new URL(req.url).searchParams.get("force") === "1";
    const rows = await getLiveAtp({ force });
    return ok(rows);
  });
}
