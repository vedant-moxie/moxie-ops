import "server-only";
import * as XLSX from "xlsx";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { refreshSkuMasterCache } from "@/lib/services/sku-master";

/**
 * Imports standard-platform listing IDs from the Beauty Comm Master Tracker's
 * "Product Master" sheet and merges them into the SkuMaster table.
 *
 * The "Product Master" sheet is keyed by our internal SKU code and carries the
 * Nykaa / Myntra / Tira (SAP) / Purplle listing codes plus their numeric PIDs.
 * We map every platform id → internal SKU so the resolver can identify POs/rows
 * from those channels (mirrors how the "SKU Master" workbook covers quick-comm).
 *
 * This import is intentionally non-destructive: it only writes the standard-
 * platform columns (+ name / ean / mrp when present) and never overwrites the
 * quick-commerce codes (zepto / instamart / blinkit) set by the SKU Master import.
 */

const SHEET_CANDIDATES = ["product master", "productmaster"];

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" || s === "#N/A" || s.toUpperCase() === "NA" ? null : s;
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

interface ProductMasterRow {
  internalCode: string;
  name: string | null;
  ean: string | null;
  mrp: number | null;
  nykaaCode: string | null;
  nykaaPids: string | null;
  myntraCode: string | null;
  tiraCode: string | null;
  purplleCode: string | null;
  purpllePids: string | null;
}

/** Map a header→value sheet row to the standard-platform columns we care about. */
function rowToInput(row: Record<string, unknown>): ProductMasterRow | null {
  const get = (...names: string[]) => {
    for (const n of names) {
      for (const key of Object.keys(row)) {
        if (key.trim().toLowerCase() === n.toLowerCase()) return row[key];
      }
    }
    return undefined;
  };
  const internalCode = str(get("SKU Code", "SKU", "internalCode"));
  if (!internalCode) return null;
  return {
    internalCode,
    name: str(get("SKU Name", "Name")),
    ean: str(get("EAN Code", "EAN")),
    mrp: num(get("MRP")),
    nykaaCode: str(get("Nykaa Code", "Nykaa SKU code")),
    nykaaPids: str(get("Nykaa PIDs", "Nykaa PID")),
    myntraCode: str(get("Myntra Code")),
    // The SAP code is what appears on Tira PO lines (productCode).
    tiraCode: str(get("Tira Code (SAP)", "Tira Code(SAP)", "Tira SAP Code")),
    purplleCode: str(get("Purplle Code")),
    purpllePids: str(get("Purplle PIDs", "Purplle PID")),
  };
}

export interface ProductMasterImportResult {
  ok: boolean;
  upserted: number;
  skipped: number;
  errors: string[];
}

/** Parse a Product Master xlsx/csv buffer and merge standard-platform IDs in. */
export async function importProductMasterFile(
  buf: Buffer,
  updatedBy: string,
): Promise<ProductMasterImportResult> {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName =
    wb.SheetNames.find((n) => SHEET_CANDIDATES.includes(n.trim().toLowerCase())) ??
    wb.SheetNames[0];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets[sheetName!]!,
    { defval: null },
  );

  const rows: ProductMasterRow[] = [];
  let skipped = 0;
  for (const raw of json) {
    const input = rowToInput(raw);
    if (!input) { skipped++; continue; }
    rows.push(input);
  }
  if (rows.length === 0) {
    return { ok: false, upserted: 0, skipped, errors: ["No valid rows found (need a 'SKU Code' column)"] };
  }

  const errors: string[] = [];
  let upserted = 0;
  for (const r of rows) {
    // Only the standard-platform fields — leave quick-comm codes & taxables intact.
    const merge = {
      name: r.name ?? undefined,
      ean: r.ean ?? undefined,
      mrp: r.mrp ?? undefined,
      nykaaCode: r.nykaaCode ?? undefined,
      nykaaPids: r.nykaaPids ?? undefined,
      myntraCode: r.myntraCode ?? undefined,
      tiraCode: r.tiraCode ?? undefined,
      purplleCode: r.purplleCode ?? undefined,
      purpllePids: r.purpllePids ?? undefined,
    };
    const create: Prisma.SkuMasterUncheckedCreateInput = {
      internalCode: r.internalCode,
      gstRate: 0,
      updatedBy,
      ...merge,
    };
    try {
      await prisma.skuMaster.upsert({
        where: { internalCode: r.internalCode },
        create,
        update: { ...merge, updatedBy },
      });
      upserted++;
    } catch (err) {
      errors.push(`${r.internalCode}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await refreshSkuMasterCache();
  return { ok: errors.length === 0, upserted, skipped, errors };
}
