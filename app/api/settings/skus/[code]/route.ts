import { handler, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";
import { deleteSkuMaster } from "@/lib/services/sku-master";

export const dynamic = "force-dynamic";

/** Delete one SKU master row by internal code (admin only). */
export async function DELETE(_req: Request, { params }: { params: { code: string } }) {
  return handler("DELETE /api/settings/skus/[code]", async () => {
    const actor = await requireAdmin();
    const code = decodeURIComponent(params.code);
    await deleteSkuMaster(code);
    await writeAudit({
      entityType: "SkuMaster",
      entityId: code,
      action: "SKU_MASTER_DELETE",
      performedBy: actor.label,
      changes: { internalCode: code },
    });
    return ok({ deleted: code });
  });
}
