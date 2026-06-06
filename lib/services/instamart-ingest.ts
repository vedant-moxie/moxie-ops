import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/services/audit";
import type { ParsedSheet } from "@/lib/integrations/blinkit/parse";
import { resolveFields, toNumber, toDate, type FieldMap } from "@/lib/integrations/blinkit/fields";

export interface IngestSummary {
  source: "instamart";
  fileName: string;
  headers: string[];
  fieldMap: FieldMap;
  unmappedHeaders: string[];
  totalRows: number;
  posUpserted: number;
  lineItems: number;
  skusCreated: number;
  skippedManufacturer: number;
  poNumbers: string[];
  warnings: string[];
}

// ─── Live-API ingest (used by instamart-sync.ts) ──────────────────────────────
// Works directly with raw Swiggy picker.swiggy.com objects instead of ParsedSheet
// so there's no field-name ambiguity and skuId can never be undefined.

type PoStatus =
  | "PENDING_REVIEW" | "PRIORITISED" | "ALLOCATED" | "APPROVED" | "DISPATCHED"
  | "DELIVERED" | "GRN_RECEIVED" | "CLOSED" | "DISCREPANCY" | "ON_HOLD";

function mapInstamartLiveStatus(status: string, receivingStatus: string, grnQty: number, totalQty: number): PoStatus {
  const s = status.toLowerCase();
  const r = receivingStatus.toLowerCase();
  if (s.includes("cancel") || s.includes("expir") || s.includes("reject")) return "ON_HOLD";
  if (grnQty > 0 && grnQty >= totalQty && totalQty > 0) return "CLOSED";
  // "receiving_status_not_received" contains "received" — exclude it explicitly
  if (grnQty > 0 || r.includes("partial") || (r.includes("received") && !r.includes("not_received"))) return "GRN_RECEIVED";
  if (s.includes("closed") || s.includes("complet") || s.includes("deliver")) return "GRN_RECEIVED";
  return "PENDING_REVIEW";
}

function epochMs(v: unknown): Date | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return new Date(n);
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const LIVE_LINE_KEYS = ["line_items", "lineItems", "items", "products", "skus", "order_items", "orderItems", "po_items", "poItems"];

function extractLiveLines(po: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const k of LIVE_LINE_KEYS) {
    const v = po[k];
    if (Array.isArray(v) && v.some(isRec)) return v.filter(isRec);
  }
  return null;
}

async function getOrCreateInstamartChannel(): Promise<string> {
  const existing = await prisma.channel.findFirst({ where: { name: "Instamart" } });
  if (existing) return existing.id;
  const c = await prisma.channel.create({
    data: { name: "Instamart", emailDomain: "swiggy.in", tier: "A", fillRateCommitment: 95, deliverySlaHours: 24, logoColor: "#FF5200", grnViaEmail: true },
  });
  return c.id;
}

async function resolveOrCreateSku(
  code: string,
  name: string,
  category: string,
  cache: Map<string, string>,
): Promise<{ id: string; created: boolean }> {
  const hit = cache.get(code);
  if (hit) return { id: hit, created: false };
  const existing = await prisma.sku.findUnique({ where: { internalCode: code } });
  if (existing) { cache.set(code, existing.id); return { id: existing.id, created: false }; }
  const created = await prisma.sku.create({ data: { internalCode: code, name, category, uom: "unit" } });
  cache.set(code, created.id);
  return { id: created.id, created: true };
}

/**
 * Ingest raw Swiggy Instamart PO objects (from picker.swiggy.com/api/v1/searchPurchaseOrder
 * and optionally enriched with per-PO line items) into the pipeline.
 *
 * When no line items are embedded, creates ONE summary PoLineItem from the PO-header totals
 * so the PO row is always visible in the UI and Prisma never receives an undefined skuId.
 * Idempotent per externalId "instamart:<purchase_order_id>".
 */
export async function ingestLiveInstamartPOs(
  pos: Record<string, unknown>[],
  actorLabel = "Instamart sync",
): Promise<IngestSummary> {
  const channelId = await getOrCreateInstamartChannel();
  const warnings: string[] = [];
  const poNumbers: string[] = [];
  let posUpserted = 0;
  let lineItems = 0;
  let skusCreated = 0;
  const skuCache = new Map<string, string>();

  for (const po of pos) {
    const poNo = String(po.purchase_order_id ?? po.po_number ?? po.poNumber ?? po.id ?? "").trim();
    if (!poNo) {
      warnings.push(`Skipped PO with no identifier`);
      continue;
    }

    const poDate = epochMs(po.po_date ?? po.poDate);
    const expiryDate = epochMs(po.expiry_date ?? po.expiryDate);
    const totalQty = Math.max(0, Math.round(Number(po.total_quantity ?? po.totalQuantity ?? po.total_qty ?? 0) || 0));
    const grnQty = Math.max(0, Math.round(Number(po.grn_quantity ?? po.grnQuantity ?? 0) || 0));
    const pendingQty = Math.max(0, Math.round(Number(po.pending_quantity ?? po.pendingQuantity ?? 0) || 0));
    const totalValue = Number(po.value ?? po.totalValue ?? po.total_value ?? 0) || null;
    const statusRaw = String(po.status ?? "");
    const receivingStatusRaw = String(po.receiving_status ?? po.receivingStatus ?? "");
    const status = mapInstamartLiveStatus(statusRaw, receivingStatusRaw, grnQty, totalQty);

    type LineSpec = { code: string; name: string; qty: number; unitPrice: number | null; rawData: Prisma.InputJsonValue };
    let lineSpecs: LineSpec[];

    const apiLines = extractLiveLines(po);
    if (apiLines && apiLines.length > 0) {
      lineSpecs = apiLines.map((line, i) => {
        // external_item_code is the native field from listPurchaseOrderLines;
        // description is the native product name field from that endpoint.
        const rawCode = String(line.external_item_code ?? line.item_code ?? line.itemCode ?? line.sku_code ?? line.skuCode ?? line.product_code ?? line.productCode ?? "").trim();
        const rawName = String(line.description ?? line.item_name ?? line.itemName ?? line.product_name ?? line.productName ?? "").trim();
        const code = rawCode ||
          (rawName ? "IM-" + rawName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24).replace(/^-|-$/g, "") : "") ||
          `IM-${poNo.replace(/[^A-Z0-9]/gi, "").slice(0, 12)}-L${i}`;
        const name = rawName || code;
        const qty = Math.max(0, Math.round(Number(line.quantity ?? line.qty ?? line.ordered_qty ?? line.orderedQty ?? 0) || 0));
        const unitPrice = Number(line.unit_price ?? line.unitPrice ?? line.price ?? null) || null;
        return { code, name, qty, unitPrice, rawData: line as Prisma.InputJsonValue };
      });
    } else {
      // Header-only: create a single summary line so the PO is visible and never crashes
      const summaryCode = `IM-SUMM-${poNo.replace(/[^A-Z0-9]/gi, "").slice(0, 16)}`;
      const summaryName = `Instamart PO ${poNo}${totalQty > 0 ? ` (${totalQty} units)` : ""}`;
      const unitPrice = totalValue && totalQty > 0 ? Math.round((totalValue / totalQty) * 100) / 100 : null;
      lineSpecs = [{ code: summaryCode, name: summaryName, qty: Math.max(1, totalQty), unitPrice, rawData: po as Prisma.InputJsonValue }];
      warnings.push(`PO ${poNo}: API returned no line items — 1 summary line created (qty=${totalQty}, value=${totalValue ?? "?"}).`);
    }

    // Resolve / create SKUs — every lineSpec gets a valid skuId here
    const resolvedLines: { skuId: string; channelSkuCode: string | null; requestedQty: number; unitPrice: number | null; rawData: Prisma.InputJsonValue }[] = [];
    for (const spec of lineSpecs) {
      const { id: skuId, created } = await resolveOrCreateSku(spec.code, spec.name, "Instamart", skuCache);
      if (created) skusCreated++;
      resolvedLines.push({ skuId, channelSkuCode: spec.code, requestedQty: spec.qty, unitPrice: spec.unitPrice, rawData: spec.rawData });
    }

    const externalId = `instamart:${poNo}`;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const dbPo = await tx.purchaseOrder.upsert({
        where: { externalId },
        create: {
          channelId, externalId, source: "INSTAMART", channelPoNumber: poNo, status,
          poDate, requestedDeliveryDate: expiryDate, totalRequestedValue: totalValue,
          rawData: po as Prisma.InputJsonValue, rawEmailSubject: `Instamart PO ${poNo}`,
          ...(poDate ? { createdAt: poDate } : {}),
        },
        update: { channelPoNumber: poNo, status, poDate, requestedDeliveryDate: expiryDate, totalRequestedValue: totalValue, rawData: po as Prisma.InputJsonValue },
      });

      await tx.poLineItem.deleteMany({ where: { poId: dbPo.id } });
      for (const line of resolvedLines) {
        await tx.poLineItem.create({ data: { poId: dbPo.id, ...line } });
      }

      await tx.discrepancy.deleteMany({ where: { poId: dbPo.id } });
      await tx.grnRecord.deleteMany({ where: { poId: dbPo.id } });
      if (grnQty > 0 && resolvedLines.length > 0) {
        const allReceived = grnQty >= totalQty && totalQty > 0;
        await tx.grnRecord.create({
          data: {
            poId: dbPo.id, source: "PORTAL", channelGrnNumber: null,
            status: allReceived ? "ACCEPTED" : "PENDING_RECONCILIATION",
            receivedAt: expiryDate ?? poDate,
            lineItems: {
              create: resolvedLines.map((l) => ({
                skuId: l.skuId,
                receivedQty: Math.min(grnQty, l.requestedQty),
                rejectedQty: 0,
              })),
            },
          },
        });
      }

      await writeAudit({
        tx, entityType: "PurchaseOrder", entityId: dbPo.id, action: "INSTAMART_IMPORTED",
        performedBy: actorLabel,
        changes: { poNumber: poNo, lines: resolvedLines.length, totalValue, grnQty, status },
      });
    });

    posUpserted++;
    lineItems += resolvedLines.length;
    poNumbers.push(poNo);
  }

  return {
    source: "instamart",
    fileName: `instamart-live-${pos.length}-pos`,
    headers: [],
    fieldMap: {},
    unmappedHeaders: [],
    totalRows: pos.length,
    posUpserted,
    lineItems,
    skusCreated,
    skippedManufacturer: 0,
    poNumbers,
    warnings,
  };
}

async function getInstamartChannelId(): Promise<string> {
  const existing =
    (await prisma.channel.findFirst({ where: { name: "Instamart" } })) ??
    (await prisma.channel.findUnique({ where: { emailDomain: "swiggy.in" } }));
  if (existing) return existing.id;
  const created = await prisma.channel.create({
    data: {
      name: "Instamart",
      emailDomain: "swiggy.in",
      tier: "A",
      fillRateCommitment: 95,
      deliverySlaHours: 24,
      logoColor: "#FF5200",
      grnViaEmail: true,
    },
  });
  return created.id;
}

/** Map Instamart po_state + received quantities to our pipeline status. */
function mapStatus(rawState: string, totalReceived: number, allReceived: boolean): PoStatus {
  if (allReceived) return "CLOSED"; // fully delivered + GRN'd
  if (totalReceived > 0) return "GRN_RECEIVED"; // partially received
  if (/cancel|expired|reject/.test(rawState)) return "ON_HOLD";
  return "PENDING_REVIEW"; // open / scheduled → still to allocate
}

// stableKey is "${poNo}:${lineIndex}" — consistent between the SKU-prefetch pass and the
// per-group line-data pass so the fallback code never diverges and skuId is always found.
function skuCodeFor(itemCode: string | undefined, itemName: string | undefined, stableKey: string): string {
  if (itemCode && itemCode.trim()) return itemCode.trim();
  if (itemName && itemName.trim()) {
    return "IM-" + itemName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24);
  }
  return `IM-SUMM-${stableKey.replace(/[^A-Z0-9]/gi, "-").slice(0, 20)}`;
}

/**
 * Ingest parsed Instamart PO rows into the PO pipeline. Idempotent per PO number.
 * Mirrors the Blinkit ingest: rows are header-keyed (flattened from the portal's
 * JSON line items), so the channel-agnostic field resolver maps them the same way.
 */
export async function ingestInstamartRows(
  sheet: ParsedSheet,
  fileName: string,
  actorLabel = "Instamart import",
): Promise<IngestSummary> {
  const channelId = await getInstamartChannelId();
  const fieldMap = resolveFields(sheet.headers);
  const warnings: string[] = [];

  const get = (row: Record<string, string>, c: keyof FieldMap): string | undefined => {
    const h = fieldMap[c];
    return h ? row[h] : undefined;
  };

  // Group rows by PO number (fallback: one synthetic PO for the whole file).
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of sheet.rows) {
    const poNo = (get(row, "poNumber") ?? "").trim() || `FILE-${fileName}`;
    const arr = groups.get(poNo) ?? [];
    arr.push(row);
    groups.set(poNo, arr);
  }
  if (!fieldMap.poNumber) warnings.push("No PO-number column detected — grouped all rows under one PO.");
  if (!fieldMap.quantity) warnings.push("No quantity column detected — quantities default to 0.");

  // Optional manufacturer/brand filter (case-insensitive). Empty = ingest everything.
  const mfgFilter = env.INSTAMART_MANUFACTURER_FILTER.trim().toLowerCase();
  let skippedManufacturer = 0;
  if (mfgFilter && fieldMap.manufacturer) {
    for (const [poNo, rows] of [...groups]) {
      const mfg = (get(rows[0]!, "manufacturer") ?? "").toLowerCase();
      if (!mfg.includes(mfgFilter)) {
        groups.delete(poNo);
        skippedManufacturer++;
      }
    }
  } else if (mfgFilter && !fieldMap.manufacturer) {
    warnings.push("Manufacturer filter set but no manufacturer column found — ingesting all POs.");
  }
  const survivingRows = [...groups.values()].flat();

  // Pre-resolve / create SKUs using a stable "${poNo}:${localLineIdx}" key so the
  // code produced here matches exactly what the per-group pass below will look up.
  const skuIdByCode = new Map<string, string>();
  let skusCreated = 0;
  const poLineCounter = new Map<string, number>(); // track per-PO row index for stable key
  for (const [gPoNo, gRows] of groups) {
    for (let li = 0; li < gRows.length; li++) {
      const row = gRows[li]!;
      const stableKey = `${gPoNo}:${li}`;
      const code = skuCodeFor(get(row, "itemCode"), get(row, "itemName"), stableKey);
      poLineCounter.set(gPoNo, li);
      if (skuIdByCode.has(code)) continue;
      const name = (get(row, "itemName") ?? code).trim() || code;
      const existing = await prisma.sku.findUnique({ where: { internalCode: code } });
      if (existing) {
        skuIdByCode.set(code, existing.id);
      } else {
        const created = await prisma.sku.create({
          data: {
            internalCode: code,
            name,
            category: (get(row, "category") ?? "Instamart").trim() || "Instamart",
            uom: (get(row, "uom") ?? "unit").trim() || "unit",
          },
        });
        skuIdByCode.set(code, created.id);
        skusCreated++;
      }
    }
  }
  void poLineCounter; // used only for the sku-prefetch pass

  let posUpserted = 0;
  let lineItems = 0;
  const poNumbers: string[] = [];

  for (const [poNo, rows] of groups) {
    const head = rows[0]!;
    const poDate = toDate(get(head, "poDate"));
    const deliveryDate = toDate(get(head, "deliveryDate"));

    const rawStatus = (get(head, "status") ?? "").trim().toLowerCase();

    let total = 0;
    let totalReceived = 0;
    const lineData = rows.map((row, i) => {
      const stableKey = `${poNo}:${i}`;
      const code = skuCodeFor(get(row, "itemCode"), get(row, "itemName"), stableKey);
      const ordered = Math.max(0, Math.round(toNumber(get(row, "quantity")) ?? 0));
      const remainingRaw = toNumber(get(row, "remaining"));
      // received = ordered - remaining (when remaining is known and <= ordered)
      const received =
        remainingRaw != null ? Math.max(0, Math.min(ordered, ordered - Math.round(remainingRaw))) : 0;
      totalReceived += received;
      const unit = toNumber(get(row, "unitPrice")) ?? toNumber(get(row, "mrp"));
      const lineVal = toNumber(get(row, "lineValue")) ?? (unit != null ? unit * ordered : null);
      if (lineVal != null) total += lineVal;
      const skuId = skuIdByCode.get(code);
      if (!skuId) {
        // Should not happen with stable keys, but guard to never pass undefined to Prisma
        warnings.push(`PO ${poNo} line ${i}: skuId not found for code "${code}" — skipping line`);
        return null;
      }
      return {
        line: {
          skuId,
          channelSkuCode: get(row, "itemCode") ?? null,
          requestedQty: ordered,
          unitPrice: unit,
          rawData: row as Prisma.InputJsonValue,
        },
        received,
      };
    }).filter((l): l is NonNullable<typeof l> => l !== null);

    const allReceived = lineData.length > 0 && lineData.every((l) => l.received >= l.line.requestedQty);
    const status = mapStatus(rawStatus, totalReceived, allReceived);
    const hasGrn = totalReceived > 0;

    const externalId = `instamart:${poNo}`;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const po = await tx.purchaseOrder.upsert({
        where: { externalId },
        create: {
          channelId,
          externalId,
          source: "INSTAMART",
          channelPoNumber: poNo,
          status,
          poDate: poDate ?? undefined,
          requestedDeliveryDate: deliveryDate ?? undefined,
          totalRequestedValue: total || null,
          rawData: head as Prisma.InputJsonValue,
          rawEmailSubject: `Instamart PO ${poNo}`,
          ...(poDate ? { createdAt: poDate } : {}),
        },
        update: {
          channelPoNumber: poNo,
          status,
          poDate: poDate ?? undefined,
          requestedDeliveryDate: deliveryDate ?? undefined,
          totalRequestedValue: total || null,
          rawData: head as Prisma.InputJsonValue,
        },
      });

      // Replace line items (idempotent re-import).
      await tx.poLineItem.deleteMany({ where: { poId: po.id } });
      for (const { line } of lineData) {
        await tx.poLineItem.create({ data: { ...line, poId: po.id } });
      }

      // Replace GRN (received quantities). Stored as a PORTAL GRN so PO detail shows it.
      await tx.discrepancy.deleteMany({ where: { poId: po.id } });
      await tx.grnRecord.deleteMany({ where: { poId: po.id } });
      if (hasGrn) {
        await tx.grnRecord.create({
          data: {
            poId: po.id,
            source: "PORTAL",
            channelGrnNumber: null,
            status: allReceived ? "ACCEPTED" : "PENDING_RECONCILIATION",
            receivedAt: deliveryDate ?? poDate ?? undefined,
            lineItems: {
              create: lineData
                .filter((l) => l.received > 0)
                .map((l) => ({ skuId: l.line.skuId, receivedQty: l.received, rejectedQty: 0 })),
            },
          },
        });
      }

      await writeAudit({
        tx,
        entityType: "PurchaseOrder",
        entityId: po.id,
        action: "INSTAMART_IMPORTED",
        performedBy: actorLabel,
        changes: { poNumber: poNo, lines: lineData.length, totalValue: total, received: totalReceived, status },
      });
    });
    posUpserted++;
    lineItems += lineData.length;
    poNumbers.push(poNo);
  }

  const mappedHeaders = new Set(Object.values(fieldMap));
  const unmappedHeaders = sheet.headers.filter((h) => !mappedHeaders.has(h));

  return {
    source: "instamart",
    fileName,
    headers: sheet.headers,
    fieldMap,
    unmappedHeaders,
    totalRows: sheet.rows.length,
    posUpserted,
    lineItems,
    skusCreated,
    skippedManufacturer,
    poNumbers,
    warnings,
  };
}
