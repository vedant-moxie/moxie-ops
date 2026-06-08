import { buildGrnExport, xlsxResponse } from "@/lib/services/excel-export";

export const dynamic = "force-dynamic";

export async function GET() {
  const buf = await buildGrnExport();
  const date = new Date().toISOString().slice(0, 10);
  return xlsxResponse(buf, `moxie-grn-${date}.xlsx`);
}
