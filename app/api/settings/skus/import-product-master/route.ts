import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";
import { importProductMasterFile } from "@/lib/services/product-master-import";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Upload the Beauty Comm Master Tracker (Product Master sheet) and merge the
 * standard-platform listing IDs (Nykaa / Myntra / Tira / Purplle) into SkuMaster.
 * Non-destructive: quick-commerce codes & taxables are left untouched. Admin only.
 */
export async function POST(req: NextRequest) {
  return handler("POST /api/settings/skus/import-product-master", async () => {
    const actor = await requireAdmin();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("No file uploaded (field 'file')");
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await importProductMasterFile(buf, actor.label);
    await writeAudit({
      entityType: "SkuMaster",
      entityId: "import-product-master",
      action: "PRODUCT_MASTER_IMPORT",
      performedBy: actor.label,
      changes: { fileName: file.name, upserted: result.upserted, skipped: result.skipped, errors: result.errors.length },
    });
    return ok(result);
  });
}
