import { buildOrdersExport, xlsxResponse } from "@/lib/services/excel-export";

export const dynamic = "force-dynamic";

export async function GET() {
  const buf = await buildOrdersExport();
  const date = new Date().toISOString().slice(0, 10);
  return xlsxResponse(buf, `moxie-orders-${date}.xlsx`);
}
