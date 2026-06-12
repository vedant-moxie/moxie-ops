/**
 * Populate SkuMaster.tiraCode + ean from the "Product Master" sheet of the
 * Beauty Comm Master Tracker workbook.
 *
 * Tira PO lines carry `productCode` = the sheet's "Tira Code (SAP)" column
 * (e.g. 494619783), which maps to our internal SKU code (e.g. GCS200). Writing
 * that into SkuMaster.tiraCode lets the SKU mapper resolve Tira POs
 * deterministically (mirrors the blinkitCode/nykaaCode fast-path).
 *
 * Usage: node scripts/populate-tira-master.cjs ["<workbook>.xlsx"]
 */
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const FILE = process.argv[2] || "Beauty Comm Master Tracker 2026-2027.xlsx";
const SHEET = "Product Master";

// Product Master column indices (0-based):
const COL = { skuCode: 0, ean: 2, name: 3, tiraCodeSap: 11 };

async function main() {
  const wb = XLSX.readFile(FILE);
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error(`Sheet "${SHEET}" not found in ${FILE}`);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  let updated = 0, created = 0, skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const internalCode = String(r[COL.skuCode] || "").trim();
    const tiraCode = String(r[COL.tiraCodeSap] || "").trim();
    const ean = String(r[COL.ean] || "").trim();
    const name = String(r[COL.name] || "").trim();
    // Only rows that have a real internal code + a numeric Tira SAP code.
    if (!internalCode || !/^[0-9]+$/.test(tiraCode)) { skipped++; continue; }

    const existing = await prisma.skuMaster.findUnique({ where: { internalCode } });
    if (existing) {
      await prisma.skuMaster.update({
        where: { internalCode },
        data: { tiraCode, ean: ean || existing.ean, name: existing.name || name || undefined },
      });
      updated++;
    } else {
      await prisma.skuMaster.create({
        data: { internalCode, tiraCode, ean: ean || null, name: name || null },
      });
      created++;
    }
  }
  console.log(`[tira-master] tiraCode populated — updated ${updated}, created ${created}, skipped ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
