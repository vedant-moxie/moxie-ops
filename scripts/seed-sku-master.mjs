#!/usr/bin/env node
/**
 * Seeds the SkuMaster table from the "SKU Master" workbook (Master sheet).
 * Idempotent — upserts by internalCode. Names are pulled from the Sku table
 * when a matching internalCode exists.
 *
 * Usage: node scripts/seed-sku-master.mjs ["path/to/workbook.xlsx"]
 */
import XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKBOOK = process.argv[2] || path.join(ROOT, "SKU Master _ Portal Links  (1).xlsx");

const prisma = new PrismaClient();

const INVALID = new Set(["", "0", "#N/A", "NA", "N/A"]);
const str = (v) => {
  const s = String(v ?? "").trim();
  return INVALID.has(s) ? null : s;
};
const num = (v) => {
  const s = String(v ?? "").trim().replace(/,/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function main() {
  const wb = XLSX.readFile(WORKBOOK);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Master"], { header: 1 });
  const data = rows.slice(1).filter((r) => r && str(r[0]));

  const skus = await prisma.sku.findMany({ select: { internalCode: true, name: true } });
  const nameByCode = new Map(skus.map((s) => [s.internalCode, s.name]));

  let n = 0;
  for (const r of data) {
    const internalCode = str(r[0]);
    const fields = {
      name: nameByCode.get(internalCode) ?? null,
      hsnCode: str(r[1]),
      gstRate: num(r[2]) ?? 0,
      mrp: num(r[3]),
      taxableB2B: num(r[4]),
      zeptoCode: str(r[5]),
      taxableZepto: num(r[6]),
      nykaaCode: str(r[7]),
      taxableNykaa: num(r[8]),
      instamartCode: str(r[9]),
      taxableInstamart: num(r[10]),
      taxableMyntra: num(r[11]),
      blinkitCode: str(r[12]),
      taxableBlinkit: num(r[13]),
      taxableReliance: num(r[14]),
      taxableAmazonNow: num(r[15]),
      updatedBy: "seed",
    };
    await prisma.skuMaster.upsert({
      where: { internalCode },
      create: { internalCode, ...fields },
      update: fields,
    });
    n++;
  }
  console.log(`Seeded ${n} SkuMaster rows from ${path.basename(WORKBOOK)}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
