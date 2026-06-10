import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { requireAuth, requireAdmin } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";
import { listSkuMaster, upsertSkuMaster, normalizeInput } from "@/lib/services/sku-master";

export const dynamic = "force-dynamic";

const nz = z.number().nullable().optional();
const sz = z.string().trim().max(120).nullable().optional();

const upsertSchema = z.object({
  internalCode: z.string().trim().min(1).max(64),
  name: sz,
  hsnCode: sz,
  gstRate: nz,
  mrp: nz,
  taxableB2B: nz,
  zeptoCode: sz,
  nykaaCode: sz,
  instamartCode: sz,
  blinkitCode: sz,
  taxableZepto: nz,
  taxableNykaa: nz,
  taxableInstamart: nz,
  taxableMyntra: nz,
  taxableBlinkit: nz,
  taxableReliance: nz,
  taxableAmazonNow: nz,
});

/** List the full SKU master (any signed-in user). */
export async function GET() {
  return handler("GET /api/settings/skus", async () => {
    await requireAuth();
    return ok(await listSkuMaster());
  });
}

/** Create or update one SKU master row (admin only). */
export async function POST(req: NextRequest) {
  return handler("POST /api/settings/skus", async () => {
    const actor = await requireAdmin();
    const body = upsertSchema.parse(await req.json());
    const input = normalizeInput(body as Record<string, unknown>);
    if (!input) throw new Error("internalCode is required");
    const row = await upsertSkuMaster(input, actor.label);
    await writeAudit({
      entityType: "SkuMaster",
      entityId: row.internalCode,
      action: "SKU_MASTER_UPSERT",
      performedBy: actor.label,
      changes: { internalCode: row.internalCode },
    });
    return ok(row);
  });
}
