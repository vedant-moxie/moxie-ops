import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["resolve", "reopen"]),
  note: z.string().max(500).optional(),
});

/**
 * Manually mark an SO-entry flag as handled (or reopen it). This does NOT change the
 * verdict — the next verification run re-derives it from WMS, and clears the
 * resolution by itself if the verdict changes.
 */
export async function PATCH(req: NextRequest, { params }: { params: { poId: string } }) {
  return handler("PATCH /api/so-checks/[poId]/resolve", async () => {
    const actor = await currentActor();
    const { action, note } = schema.parse(await req.json());

    const check = await prisma.soCheck.findUnique({ where: { poId: params.poId } });
    if (!check) return fail(new Error("No SO check for this PO"), 404);
    if (action === "resolve" && (check.result === "MATCHED" || check.result === "QTY_UNVERIFIED")) {
      // Neither is a warehouse mistake: MATCHED ties out, and QTY_UNVERIFIED means the
      // SO is there but the WMS read path won't give us quantities.
      return fail(new Error("Nothing to resolve — no flag is open on this PO"), 400);
    }

    await prisma.soCheck.update({
      where: { poId: params.poId },
      data:
        action === "resolve"
          ? { resolvedAt: new Date(), resolvedBy: actor.label, note: note ?? null }
          : { resolvedAt: null, resolvedBy: null, note: null },
    });

    await writeAudit({
      entityType: "PurchaseOrder",
      entityId: params.poId,
      action: action === "resolve" ? "SO_CHECK_RESOLVED" : "SO_CHECK_REOPENED",
      performedBy: actor.label,
      changes: { result: check.result, note: note ?? null },
    });

    return ok({ poId: params.poId, action });
  });
}
