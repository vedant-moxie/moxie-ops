/**
 * Unit tests for the WMS sales-order report parser (plan 008).
 * Run with:
 *   DATABASE_URL=postgresql://x:x@localhost:5432/x \
 *   npx tsx --conditions=react-server lib/integrations/wms.test.ts
 *
 * No DB or network: lib/env.ts only *validates* DATABASE_URL (never connects), and
 * --conditions=react-server is what lets the "server-only" import resolve outside Next.
 *
 * Covers both sources: the Outward LOI Report (the LIVE source of line quantities —
 * fixtures use its real header row) and the generic salesorder-report parser kept for a
 * future purpose-built report. Also covers the failure modes that must stay loud rather
 * than silently returning [], since an empty list reads as "nobody punched anything".
 */
import { strict as assert } from "node:assert";
import * as XLSX from "xlsx";
import { parseOutwardLoiSalesOrders, parseSalesOrderReportXlsx, parseWmsDate } from "./wms.js";

/** Build an xlsx buffer the way the portal's report engine does: title rows, then a header row. */
function workbook(rows: unknown[][], sheetName = "Salesorder Report"): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["BEYOUTIFUL CONSUMER VENTURES PVT. LTD"],
    ["Location : Pan India"],
    ["Salesorder Report: 03-08-2026 11:05:34"],
    [],
    [],
    ...rows,
  ]);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const HEADER = [
  "WAREHOUSE", "SALESORDER NO", "ORDER NO", "SALESORDER REF NO", "PARTY REF ORDER NO",
  "ORDER DATE", "ORDER STATUS", "SKU CODE", "SKU DESCRIPTION", "ORDER QTY",
];
const row = (
  so: string, orderNo: string, ref: string, sku: string, qty: number, wh = "RGL GURGAON HARYANA",
) => [wh, so, orderNo, ref, "", "01-08-2026", "Open", sku, `${sku} desc`, qty];

// ── grouping: one row per SO, lines nested ────────────────────────────────

const parsed = parseSalesOrderReportXlsx(
  workbook([
    HEADER,
    row("SO-77001", "BLK-PO-99812", "MB - 26/27 - 1458", "GCS200", 120),
    row("SO-77001", "BLK-PO-99812", "MB - 26/27 - 1458", "DRM300", 60),
    row("SO-77002", "ZEP-PO-4471", "MB - 26/27 - 1459", "HRHM100", 24),
  ]),
);
assert.equal(parsed.length, 2, "two sales orders");

const first = parsed.find((s) => s.salesOrderId === "SO-77001")!;
assert.equal(first.orderNo, "BLK-PO-99812", "channel PO from ORDER NO");
assert.equal(first.refNo, "MB - 26/27 - 1458", "MB ref from SALESORDER REF NO");
assert.equal(first.partyRefOrderNo, null, "blank cells read as null, not empty string");
assert.equal(first.warehouseName, "RGL GURGAON HARYANA");
assert.equal(first.status, "Open");
assert.deepEqual(
  first.lines,
  [{ skuCode: "GCS200", qty: 120 }, { skuCode: "DRM300", qty: 60 }],
  "both lines attached to their SO",
);
assert.equal(first.orderDate?.getFullYear(), 2026, "dd-MM-yyyy parsed");
assert.equal(first.orderDate?.getMonth(), 7, "…as August (0-indexed)");
assert.equal(first.orderDate?.getDate(), 1);

// ── a SKU repeated across batches sums, never overwrites ──────────────────

const batched = parseSalesOrderReportXlsx(
  workbook([
    HEADER,
    row("SO-88001", "BLK-PO-1", "MB - 26/27 - 1", "GCS200", 70),
    row("SO-88001", "BLK-PO-1", "MB - 26/27 - 1", "GCS200", 50),
  ]),
);
assert.deepEqual(batched[0]!.lines, [{ skuCode: "GCS200", qty: 120 }], "batch rows sum to 120");

// ── header tolerance: different naming, different column order ────────────

const alt = parseSalesOrderReportXlsx(
  workbook([
    ["SO No.", "Customer Order No", "Reference No", "Quantity", "SKU Code", "Warehouse"],
    ["SO-1", "BLK-PO-2", "MB - 26/27 - 2", "1,200", "GCS200", "BHIWANDI - 2"],
  ]),
);
assert.equal(alt.length, 1, "alternative header names still parse");
assert.deepEqual(alt[0]!.lines, [{ skuCode: "GCS200", qty: 1200 }], "comma-formatted qty");
assert.equal(alt[0]!.salesOrderId, "SO-1");
assert.equal(alt[0]!.refNo, "MB - 26/27 - 2");

// ── failure modes stay loud ───────────────────────────────────────────────
// A silent [] would read as "nobody punched anything" and flag every PO, so both of
// these must throw instead.

assert.throws(
  () => parseSalesOrderReportXlsx(workbook([["WAREHOUSE", "QTY", "VALUE"], ["x", 1, 2]])),
  /no sales-order header row found/,
  "no recognisable header row → throws",
);
assert.throws(
  () =>
    parseSalesOrderReportXlsx(
      workbook([["SALESORDER NO", "SKU CODE", "SKU DESCRIPTION"], ["SO-1", "GCS200", "d"]]),
    ),
  /missing required columns/,
  "header found but no quantity column → throws, listing what it saw",
);

// Rows without a SKU or an SO id are skipped, not fatal (reports carry blank/total rows).
const withJunk = parseSalesOrderReportXlsx(
  workbook([
    HEADER,
    row("SO-99001", "BLK-PO-3", "MB - 26/27 - 3", "GCS200", 10),
    ["", "", "", "", "", "", "", "", "", ""],
    ["RGL GURGAON HARYANA", "", "", "", "", "", "", "GCS200", "d", 5],
    ["Total", "", "", "", "", "", "", "", "", 15],
  ]),
);
assert.equal(withJunk.length, 1, "blank and total rows ignored");
assert.deepEqual(withJunk[0]!.lines, [{ skuCode: "GCS200", qty: 10 }]);

// ── Outward LOI Report → sales orders WITH quantities ─────────────────────
// Real header row from Outward_LOI_Report-03_Aug_26_6508.xlsx. This is the live source
// of line quantities, so the column mapping and batch summing are load-bearing.

const LOI_HEADER = [
  "Sr.No.", "WMS Outward No.", "Outward Date", "Order Received Date", "Dispatch Date",
  "MOXIE PO NO", "Invoice No.", "Invoice Dt.", "Inv. Qty. As per WMS", "SKU Code",
  "SKU Name", "Batch No.", "SKU Quantity", "Box Qty", "Loose Qty", "Weight",
  "Customer Name", "Location", "Transporter Name", "Booking To", "Docket No.",
  "Freight Term", "Delivery Term", "LR CC", "CHANNEL PO NO", "CHANNEL",
  "Road Permit Form No.", "Remarks", "Instruction to Transporter", "Instruction to W/H",
];
const loiRow = (
  so: string, moxiePo: string, sku: string, qty: number | string,
  batch = "", channelPo = "AHD9923", customer = "Nykaa-Ahmedabad Warehouse",
) => [
  "1", so, "01-08-2026", "01-08-2026", "01-08-2026", moxiePo, "HR/26-27/101941", "01-08-2026",
  "103", sku, `${sku} name`, batch, qty, "1", "0", "10", customer, "", "RIVIGO", "AHMEDABAD",
  "5000220334", "PAID", "", "AHD9923", channelPo, "Nykaa", "", "", "", "",
];

const loi = parseOutwardLoiSalesOrders(
  workbook(
    [
      LOI_HEADER,
      loiRow("SO/BCVG/26-27/02303", "MB0920", "SW15", 11, "E26030"),
      loiRow("SO/BCVG/26-27/02303", "MB0920", "SW15", 92), // same SKU, second batch
      loiRow("SO/BCVG/26-27/02303", "MB0920", "THRR", 1),
      loiRow("SO/BCVG/26-27/02304", "MB0921", "GCS200", 24, "", "BLK-77", "Blinkit-Kundli"),
    ],
    "Outward LOI Report",
  ),
  "RGL GURGAON HARYANA",
);

assert.equal(loi.length, 2, "two sales orders");
const loiFirst = loi.find((s) => s.salesOrderId === "SO/BCVG/26-27/02303")!;
assert.equal(loiFirst.refNo, "MB0920", "MOXIE PO NO → refNo");
assert.equal(loiFirst.orderNo, "AHD9923", "CHANNEL PO NO → orderNo (not the CHANNEL name)");
assert.equal(loiFirst.customer, "Nykaa-Ahmedabad Warehouse", "Customer Name → party");
assert.equal(loiFirst.warehouseName, "RGL GURGAON HARYANA", "warehouse comes from the caller");
assert.equal(loiFirst.linesKnown, true, "report rows carry real quantities");
assert.deepEqual(
  loiFirst.lines.sort((a, b) => a.skuCode.localeCompare(b.skuCode)),
  [{ skuCode: "SW15", qty: 103 }, { skuCode: "THRR", qty: 1 }],
  "the same SKU across two batches sums to 103, and does not overwrite",
);
assert.equal(loi.find((s) => s.salesOrderId === "SO/BCVG/26-27/02304")!.orderNo, "BLK-77");

// "CHANNEL" must not steal the "CHANNEL PO NO" column, and "Inv. Qty. As per WMS" /
// "Box Qty" / "Loose Qty" must not be read as the SKU quantity.
assert.notEqual(loiFirst.orderNo, "Nykaa", "CHANNEL name is not the channel PO number");
assert.equal(
  parseOutwardLoiSalesOrders(workbook([LOI_HEADER, loiRow("SO/X", "MB1", "AAA", 7)]), "W")[0]!.lines[0]!.qty,
  7,
  "SKU Quantity column is used, not Inv. Qty. (103) or Box Qty (1)",
);

assert.throws(
  () => parseOutwardLoiSalesOrders(workbook([["Sr.No.", "SKU Code", "SKU Quantity"], ["1", "A", 1]])),
  /no Outward LOI header row found/,
  "a sheet without the outward-no column throws instead of silently returning []",
);

// ── date formats ──────────────────────────────────────────────────────────

assert.equal(parseWmsDate("2026-08-01")?.getMonth(), 7, "yyyy-MM-dd");
assert.equal(parseWmsDate("01/08/2026")?.getDate(), 1, "dd/MM/yyyy");
assert.equal(parseWmsDate("01-08-2026 14:30:00")?.getDate(), 1, "trailing time ignored");
assert.equal(parseWmsDate(""), null, "empty is null");
assert.equal(parseWmsDate("garbage"), null, "unparseable is null");
assert.equal(parseWmsDate(new Date("2026-08-01"))?.getTime(), new Date("2026-08-01").getTime());

console.log("✓ wms sales-order parser: all assertions passed");
