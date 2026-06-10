import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";
import { importSkuMasterFile } from "@/lib/services/sku-master";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Upload an xlsx/csv master file (Master-sheet layout) and upsert all rows (admin only). */
export async function POST(req: NextRequest) {
  return handler("POST /api/settings/skus/import", async () => {
    const actor = await requireAdmin();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("No file uploaded (field 'file')");
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await importSkuMasterFile(buf, actor.label);
    await writeAudit({
      entityType: "SkuMaster",
      entityId: "import",
      action: "SKU_MASTER_IMPORT",
      performedBy: actor.label,
      changes: { fileName: file.name, upserted: result.upserted, skipped: result.skipped, errors: result.errors.length },
    });
    return ok(result);
  });
}
