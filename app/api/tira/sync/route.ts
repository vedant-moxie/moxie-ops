import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { syncTira } from "@/lib/services/tira-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z
  .object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .optional();

/** Live-scrape Tira POs from srm-rrscm.ril.com and ingest them. */
export async function POST(req: NextRequest) {
  return handler("POST /api/tira/sync", async () => {
    const actor = await currentActor();
    const body = bodySchema.parse(await req.json().catch(() => ({})));
    const result = await syncTira({
      since: body?.since,
      until: body?.until,
      actorLabel: actor.label,
    });
    return ok(result);
  });
}
