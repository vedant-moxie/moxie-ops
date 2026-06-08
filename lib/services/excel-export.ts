import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveInternalSku } from "@/lib/services/sku-resolver";
import { resolveFields } from "@/lib/integrations/blinkit/fields";

/**
 * Shared Excel-export builders for Orders / Channel / GRN.
 *
 * PRINCIPLE: cells carry only REAL source values. When a field is absent from
 * the source row we emit `null` (a blank cell) rather than a fabricated number.
 * The only computed cells are faithful arithmetic of real source numbers
 * (Taxable = rate × qty, Tax = total − taxable, Fill % = received / ordered) —
 * see `lineFinancials` for the per-channel rules and guards.
 */

type Cell = string | number | null;
interface SheetSpec {
  name: string;
  aoa: Cell[][];
  /** 0-based column indexes whose http(s) text cells become clickable links. */
  linkColumns?: number[];
}

/** Parse a possibly-stringy currency/number into a finite number, else null. */
function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === "") return null;
  const cleaned = s.replace(/[₹,\s]/g, "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** First non-null number found across the candidate keys. */
function pickNum(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = num(raw[k]);
    if (v != null) return v;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Per-line financials from the line's REAL source fields. Blank where the source
 * has no usable value — never fabricated.
 *
 * Channel quirks (verified against live rawData):
 *  - Blinkit: `cost_price` is the pre-tax unit price; `total_amount` is the
 *    incl-tax line total. `tax_value`/`cgst_value`/`sgst_value`/`igst_value` are
 *    GST *rates* (%), NOT amounts — so they are deliberately NOT used for the Tax
 *    column (placing a rate there would be a fabricated amount).
 *  - Zepto: `unitPrice` pre-tax; `totalValue` is the pre-tax line total.
 *  - Instamart: money is nested objects (units/nanos) — not flat numbers, so the
 *    flat extractors return null and those cells stay blank.
 *
 * Taxable = explicit pre-tax field, else rate × qty (a faithful product of two
 * real source numbers). Tax = explicit tax-amount field, else (total − taxable)
 * only when an incl-tax total exceeds the taxable base; otherwise blank.
 */
function lineFinancials(
  raw: Record<string, unknown>,
  unitPrice: number | null,
  qty: number,
): { rate: number | null; taxable: number | null; tax: number | null; total: number | null } {
  const rate =
    (unitPrice != null ? unitPrice : null) ??
    pickNum(raw, [
      "cost_price", "unit_price", "unitPrice", "basic_cost", "landing_cost",
      "unit_cost", "landing_rate", "rate", "price",
    ]);

  const taxable =
    pickNum(raw, ["taxable_value", "taxable_amount", "taxableValue", "amount_excluding_tax"]) ??
    (rate != null && qty > 0 ? round2(rate * qty) : null);

  const total = pickNum(raw, [
    "total_amount", "total_value", "totalAmount", "totalValue",
    "amount_including_tax", "gross_amount", "line_value", "lineValue", "amount",
  ]);

  // Only explicit tax-AMOUNT fields here. Blinkit's *_value fields are rates, so
  // they are intentionally excluded.
  const explicitTax = pickNum(raw, ["tax_amount", "total_tax", "taxAmount"]);
  // Derive tax from (total − taxable) only when the incl-tax total genuinely
  // exceeds the taxable base. A near-equal total means the channel reported a
  // PRE-tax total (e.g. Zepto's totalValue) — i.e. no tax info — so leave blank
  // rather than emit a float-noise 0.
  const taxGap = total != null && taxable != null ? total - taxable : null;
  const tax =
    explicitTax ??
    (taxGap != null && taxGap > Math.max(0.5, (taxable ?? 0) * 0.001)
      ? round2(taxGap)
      : null);

  return { rate, taxable, tax, total };
}

/** Resolve the destination outlet/facility from a PO's raw source row. */
function deriveOutlet(poRaw: unknown): string | null {
  const raw = asRecord(poRaw);
  const keys = Object.keys(raw);
  if (keys.length === 0) return null;
  const fm = resolveFields(keys);
  const facility = fm.facility ? raw[fm.facility] : undefined;
  const city = fm.city ? raw[fm.city] : undefined;
  const v = String(facility ?? city ?? "").trim();
  return v || null;
}

function appUrl(): string {
  return env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
}

/** Build an .xlsx Buffer from one or more sheets. */
export function workbookToBuffer(sheets: SheetSpec[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.aoa);
    if (sheet.linkColumns?.length) {
      const ref = ws["!ref"];
      if (ref) {
        const range = XLSX.utils.decode_range(ref);
        for (const c of sheet.linkColumns) {
          for (let r = range.s.r + 1; r <= range.e.r; r++) {
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = ws[addr];
            if (cell && typeof cell.v === "string" && /^https?:\/\//.test(cell.v)) {
              cell.l = { Target: cell.v, Tooltip: "Open in Moxie Ops" };
            }
          }
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const ORDERS_HEADER = [
  "PO Number", "PO Date", "Channel", "Outlet/Facility", "Status", "PO Total Value",
  "Channel SKU Code", "Internal SKU Code", "Product", "UOM", "Ordered Qty",
  "Rate/Unit", "Taxable Value", "Tax", "Total Amount", "Source Link",
];

/**
 * All purchase orders, ONE ROW PER SKU LINE. When `source` is given the export
 * is filtered to that channel's PurchaseOrder.source.
 */
export async function buildOrdersExport(source?: string): Promise<Buffer> {
  const pos = await prisma.purchaseOrder.findMany({
    where: source ? { source } : undefined,
    orderBy: [{ poDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      channelPoNumber: true,
      source: true,
      status: true,
      poDate: true,
      totalRequestedValue: true,
      rawData: true,
      channel: { select: { name: true } },
      lineItems: {
        orderBy: { requestedQty: "desc" },
        select: {
          channelSkuCode: true,
          requestedQty: true,
          unitPrice: true,
          rawData: true,
          sku: { select: { internalCode: true, name: true, uom: true } },
        },
      },
    },
  });

  const aoa: Cell[][] = [ORDERS_HEADER];
  for (const po of pos) {
    const outlet = deriveOutlet(po.rawData);
    const link = `${appUrl()}/orders/${po.id}`;
    const poValue = po.totalRequestedValue ?? null;

    for (const li of po.lineItems) {
      const raw = asRecord(li.rawData);
      const fin = lineFinancials(raw, li.unitPrice, li.requestedQty);
      const channelCode = li.channelSkuCode ?? li.sku.internalCode;
      const internalCode = resolveInternalSku(po.source, channelCode);
      const uom = (raw.uom_text as string | undefined) ?? li.sku.uom ?? "";
      aoa.push([
        po.channelPoNumber ?? "",
        fmtDate(po.poDate),
        po.channel.name,
        outlet ?? "",
        po.status,
        poValue,
        li.channelSkuCode ?? "",
        internalCode,
        li.sku.name,
        uom,
        li.requestedQty,
        fin.rate,
        fin.taxable,
        fin.tax,
        fin.total,
        link,
      ]);
    }
  }

  return workbookToBuffer([{ name: "Purchase Orders", aoa, linkColumns: [15] }]);
}

const GRN_HEADER = [
  "PO Number", "Channel", "Outlet", "Product", "Internal SKU", "Ordered",
  "Allocated/Approved", "Received (GRN)", "Fill %", "PO Fill %", "PO Status",
  "Source Link",
];

/** Per-PO + per-SKU GRN reconciliation, with PO-level fill% / status + source link. */
export async function buildGrnExport(): Promise<Buffer> {
  const records = await prisma.grnRecord.findMany({
    orderBy: { receivedAt: "desc" },
    select: {
      po: {
        select: {
          id: true,
          channelPoNumber: true,
          status: true,
          rawData: true,
          channel: { select: { name: true } },
          lineItems: {
            select: {
              skuId: true,
              requestedQty: true,
              approvedQty: true,
              sku: { select: { internalCode: true, name: true } },
            },
          },
        },
      },
      lineItems: {
        select: {
          skuId: true,
          receivedQty: true,
          sku: { select: { internalCode: true, name: true } },
        },
      },
    },
  });

  const aoa: Cell[][] = [GRN_HEADER];
  for (const r of records) {
    const po = r.po;
    const outlet = deriveOutlet(po.rawData);
    const link = `${appUrl()}/orders/${po.id}`;

    const orderedBySku = new Map(
      po.lineItems.map((l) => [l.skuId, { qty: l.requestedQty, approved: l.approvedQty, sku: l.sku }]),
    );
    const receivedBySku = new Map(r.lineItems.map((l) => [l.skuId, { qty: l.receivedQty, sku: l.sku }]));

    const totalOrdered = po.lineItems.reduce((s, l) => s + l.requestedQty, 0);
    const totalReceived = r.lineItems.reduce((s, l) => s + l.receivedQty, 0);
    const poFillPct = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : null;

    const allSkuIds = new Set([...orderedBySku.keys(), ...receivedBySku.keys()]);
    for (const skuId of allSkuIds) {
      const ord = orderedBySku.get(skuId);
      const rec = receivedBySku.get(skuId);
      const sku = ord?.sku ?? rec?.sku;
      const ordered = ord?.qty ?? null;
      const allocated = ord?.approved ?? null;
      const received = rec?.qty ?? null;
      const fillPct =
        ordered != null && ordered > 0 && received != null
          ? Math.round((received / ordered) * 100)
          : null;
      aoa.push([
        po.channelPoNumber ?? "",
        po.channel.name,
        outlet ?? "",
        sku?.name ?? "",
        sku?.internalCode ?? "",
        ordered,
        allocated,
        received,
        fillPct,
        poFillPct,
        po.status,
        link,
      ]);
    }
  }

  return workbookToBuffer([{ name: "GRN Reconciliation", aoa, linkColumns: [11] }]);
}

/** Standard headers + Buffer body for an .xlsx download Response. */
export function xlsxResponse(buf: Buffer, filename: string): Response {
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
