import { requireAuth } from "@/lib/auth";
import { exportSkuMasterXlsx } from "@/lib/services/sku-master";

export const dynamic = "force-dynamic";

/** Download the full SKU master as an xlsx in the workbook's column layout. */
export async function GET() {
  await requireAuth();
  const buf = await exportSkuMasterXlsx();
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sku-master.xlsx"`,
    },
  });
}
