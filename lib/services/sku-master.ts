import "server-only";
import * as XLSX from "xlsx";
import type { Prisma, SkuMaster } from "@prisma/client";
import { prisma } from "@/lib/db";
import { buildMapsFromRows, setSkuMasterMaps } from "@/lib/sku-master-runtime";

/**
 * Refreshes the live SKU master cache from the DB. Falls back to the file
 * defaults (already loaded in the runtime module) when the table is empty.
 * Call at boot and after every edit so resolution + taxable checks stay current.
 */
export async function refreshSkuMasterCache(): Promise<number> {
  const rows = await prisma.skuMaster.findMany();
  if (rows.length > 0) setSkuMasterMaps(buildMapsFromRows(rows));
  return rows.length;
}

export async function listSkuMaster(): Promise<SkuMaster[]> {
  return prisma.skuMaster.findMany({ orderBy: { internalCode: "asc" } });
}

// ── Editable fields ──────────────────────────────────────────────────────────

export interface SkuMasterInput {
  internalCode: string;
  name?: string | null;
  hsnCode?: string | null;
  gstRate?: number | null;
  mrp?: number | null;
  taxableB2B?: number | null;
  zeptoCode?: string | null;
  nykaaCode?: string | null;
  instamartCode?: string | null;
  blinkitCode?: string | null;
  taxableZepto?: number | null;
  taxableNykaa?: number | null;
  taxableInstamart?: number | null;
  taxableMyntra?: number | null;
  taxableBlinkit?: number | null;
  taxableReliance?: number | null;
  taxableAmazonNow?: number | null;
}

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" || s === "#N/A" ? null : s;
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Normalise an arbitrary input object into the column set (drops unknown keys). */
export function normalizeInput(raw: Record<string, unknown>): SkuMasterInput | null {
  const internalCode = str(raw.internalCode);
  if (!internalCode) return null;
  return {
    internalCode,
    name: str(raw.name),
    hsnCode: str(raw.hsnCode),
    gstRate: num(raw.gstRate) ?? 0,
    mrp: num(raw.mrp),
    taxableB2B: num(raw.taxableB2B),
    zeptoCode: str(raw.zeptoCode),
    nykaaCode: str(raw.nykaaCode),
    instamartCode: str(raw.instamartCode),
    blinkitCode: str(raw.blinkitCode),
    taxableZepto: num(raw.taxableZepto),
    taxableNykaa: num(raw.taxableNykaa),
    taxableInstamart: num(raw.taxableInstamart),
    taxableMyntra: num(raw.taxableMyntra),
    taxableBlinkit: num(raw.taxableBlinkit),
    taxableReliance: num(raw.taxableReliance),
    taxableAmazonNow: num(raw.taxableAmazonNow),
  };
}

/** Upsert one row by internalCode and refresh the cache. */
export async function upsertSkuMaster(input: SkuMasterInput, updatedBy: string): Promise<SkuMaster> {
  const data: Prisma.SkuMasterUncheckedCreateInput = { ...input, gstRate: input.gstRate ?? 0, updatedBy };
  const row = await prisma.skuMaster.upsert({
    where: { internalCode: input.internalCode },
    create: data,
    update: data,
  });
  await refreshSkuMasterCache();
  return row;
}

export async function deleteSkuMaster(internalCode: string): Promise<void> {
  await prisma.skuMaster.delete({ where: { internalCode } });
  await refreshSkuMasterCache();
}

// ── xlsx / csv import + export (same column layout as the master workbook) ────

/** Exact header order of the "SKU Master" workbook's Master sheet. */
export const MASTER_HEADERS = [
  "SKU", "HSN CODE", "New GST Rate", "New MRP", "New Taxable Value for B2B",
  "Zepto SKU code", "Taxable Value For Zepto",
  "Nykaa SKU code", "Taxable Value For Nykaa",
  "Instamart SKU code", "Taxable Value For Instamart",
  "Taxable Value For Myntra",
  "Blinkit Sku code", "Taxable Value For Blinkit",
  "Taxable Value For Reliance", "Taxable Value For Amazon Now",
] as const;

/** Map a parsed sheet row (header→value) to an input, tolerating header variants. */
function rowToInput(row: Record<string, unknown>): SkuMasterInput | null {
  const get = (...names: string[]) => {
    for (const n of names) {
      for (const key of Object.keys(row)) {
        if (key.trim().toLowerCase() === n.toLowerCase()) return row[key];
      }
    }
    return undefined;
  };
  return normalizeInput({
    internalCode: get("SKU", "internalCode", "SKU Code"),
    hsnCode: get("HSN CODE", "hsnCode", "HSN"),
    gstRate: get("New GST Rate", "gstRate", "GST Rate"),
    mrp: get("New MRP", "mrp", "MRP"),
    taxableB2B: get("New Taxable Value for B2B", "taxableB2B"),
    zeptoCode: get("Zepto SKU code", "zeptoCode"),
    taxableZepto: get("Taxable Value For Zepto", "taxableZepto"),
    nykaaCode: get("Nykaa SKU code", "nykaaCode"),
    taxableNykaa: get("Taxable Value For Nykaa", "taxableNykaa"),
    instamartCode: get("Instamart SKU code", "instamartCode"),
    taxableInstamart: get("Taxable Value For Instamart", "taxableInstamart"),
    taxableMyntra: get("Taxable Value For Myntra", "taxableMyntra"),
    blinkitCode: get("Blinkit Sku code", "Blinkit SKU code", "blinkitCode"),
    taxableBlinkit: get("Taxable Value For Blinkit", "taxableBlinkit"),
    taxableReliance: get("Taxable Value For Reliance", "taxableReliance"),
    taxableAmazonNow: get("Taxable Value For Amazon Now", "taxableAmazonNow"),
  });
}

export interface ImportResult {
  ok: boolean;
  upserted: number;
  skipped: number;
  errors: string[];
}

/**
 * Parses an uploaded xlsx/csv buffer (Master-sheet layout) and upserts every row.
 * Refreshes the cache once at the end. Names are preserved from existing rows /
 * the Sku table when the sheet doesn't carry a product name column.
 */
export async function importSkuMasterFile(buf: Buffer, updatedBy: string): Promise<ImportResult> {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === "master") ?? wb.SheetNames[0];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName!]!, { defval: null });

  const inputs: SkuMasterInput[] = [];
  const errors: string[] = [];
  let skipped = 0;
  for (const [i, row] of json.entries()) {
    const input = rowToInput(row);
    if (!input) { skipped++; continue; }
    inputs.push(input);
  }
  if (inputs.length === 0) {
    return { ok: false, upserted: 0, skipped, errors: ["No valid rows found (need a 'SKU' column)"] };
  }

  // Preserve names: existing master rows first, then the Sku table.
  const codes = inputs.map((i) => i.internalCode);
  const [existing, skus] = await Promise.all([
    prisma.skuMaster.findMany({ where: { internalCode: { in: codes } }, select: { internalCode: true, name: true } }),
    prisma.sku.findMany({ where: { internalCode: { in: codes } }, select: { internalCode: true, name: true } }),
  ]);
  const nameByCode = new Map<string, string>();
  for (const s of skus) if (s.name) nameByCode.set(s.internalCode, s.name);
  for (const e of existing) if (e.name) nameByCode.set(e.internalCode, e.name);

  let upserted = 0;
  for (const input of inputs) {
    const name = input.name ?? nameByCode.get(input.internalCode) ?? null;
    const data: Prisma.SkuMasterUncheckedCreateInput = { ...input, name, gstRate: input.gstRate ?? 0, updatedBy };
    try {
      await prisma.skuMaster.upsert({
        where: { internalCode: input.internalCode },
        create: data,
        update: data,
      });
      upserted++;
    } catch (err) {
      errors.push(`${input.internalCode}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await refreshSkuMasterCache();
  return { ok: errors.length === 0, upserted, skipped, errors };
}

/** Serialise the whole master to an xlsx buffer in the workbook's column layout. */
export async function exportSkuMasterXlsx(): Promise<Buffer> {
  const rows = await listSkuMaster();
  const aoa: (string | number | null)[][] = [ [...MASTER_HEADERS] ];
  for (const r of rows) {
    aoa.push([
      r.internalCode, r.hsnCode, r.gstRate, r.mrp, r.taxableB2B,
      r.zeptoCode, r.taxableZepto,
      r.nykaaCode, r.taxableNykaa,
      r.instamartCode, r.taxableInstamart,
      r.taxableMyntra,
      r.blinkitCode, r.taxableBlinkit,
      r.taxableReliance, r.taxableAmazonNow,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Master");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
