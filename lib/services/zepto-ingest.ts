import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import type { ParsedSheet } from "@/lib/integrations/blinkit/parse";
import { resolveFields, toNumber, toDate, type FieldMap } from "@/lib/integrations/blinkit/fields";

export interface IngestSummary {
  source: "zepto";
  fileName: string;
  headers: string[];
  fieldMap: FieldMap;
  unmappedHeaders: string[];
  totalRows: number;
  posUpserted: number;
  lineItems: number;
  skusCreated: number;
  poNumbers: string[];
  warnings: string[];
}

// ─── Live-API ingest (used by zepto-sync.ts) ──────────────────────────────────
// Works directly with raw fcc.zepto.co.in po/filter objects instead of ParsedSheet.

type PoStatus =
  | "PENDING_REVIEW" | "PRIORITISED" | "ALLOCATED" | "APPROVED" | "DISPATCHED"
  | "DELIVERED" | "GRN_RECEIVED" | "CLOSED" | "DISCREPANCY" | "ON_HOLD";

function mapZeptoLiveStatus(status: string, grnQty: number, totalQty: number): PoStatus {
  const s = status.toLowerCase();
  if (s.includes("cancel") || s.includes("expir") || s.includes("reject") || s.includes("closed_without")) return "ON_HOLD";
  if (s.includes("delivered") || s.includes("grn") || s.includes("received")) {
    if (grnQty >= totalQty && totalQty > 0) return "CLOSED";
    return "GRN_RECEIVED";
  }
  if (s.includes("dispatched") || s.includes("shipped")) return "DISPATCHED";
  if (s.includes("approved") || s.includes("confirmed")) return "APPROVED";
  if (grnQty > 0) return "GRN_RECEIVED";
  return "PENDING_REVIEW";
}

function zEpochOrIso(v: unknown): Date | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return new Date(n > 1e11 ? n : n * 1000);
}

function isZRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ZEPTO_LINE_KEYS = ["lineItems", "line_items", "items", "skus", "products", "poItems", "orderItems", "lines"];

function extractZeptoLines(po: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const k of ZEPTO_LINE_KEYS) {
    const v = po[k];
    if (Array.isArray(v) && v.some(isZRec)) return v.filter(isZRec);
  }
  return null;
}

async function getOrCreateZeptoChannel(): Promise<string> {
  const existing = await prisma.channel.findFirst({ where: { name: "Zepto" } });
  if (existing) return existing.id;
  const c = await prisma.channel.create({
    data: { name: "Zepto", emailDomain: "zeptonow.com", tier: "A", fillRateCommitment: 95, deliverySlaHours: 24, logoColor: "#7B2D8E", grnViaEmail: true },
  });
  return c.id;
}

async function resolveOrCreateZeptoSku(
  code: string,
  name: string,
  cache: Map<string, string>,
): Promise<{ id: string; created: boolean }> {
  const hit = cache.get(code);
  if (hit) return { id: hit, created: false };
  const existing = await prisma.sku.findUnique({ where: { internalCode: code } });
  if (existing) { cache.set(code, existing.id); return { id: existing.id, created: false }; }
  const created = await prisma.sku.create({ data: { internalCode: code, name, category: "Zepto", uom: "unit" } });
  cache.set(code, created.id);
  return { id: created.id, created: true };
}

/**
 * Ingest raw Zepto PO objects from fcc.zepto.co.in/api/v1/po/filter into the pipeline.
 * Handles various Zepto field name conventions (camelCase/snake_case). When the list
 * endpoint returns header-only rows, creates a single summary PoLineItem so the PO is
 * visible and Prisma never receives an undefined skuId.
 */
export async function ingestLiveZeptoPOs(
  pos: Record<string, unknown>[],
  actorLabel = "Zepto sync",
): Promise<IngestSummary> {
  const channelId = await getOrCreateZeptoChannel();
  const warnings: string[] = [];
  const poNumbers: string[] = [];
  let posUpserted = 0;
  let lineItems = 0;
  let skusCreated = 0;
  const skuCache = new Map<string, string>();

  for (const po of pos) {
    // Zepto uses camelCase; also tolerate snake_case for future-proofing
    const poNo = String(po.id ?? po.poId ?? po.poNumber ?? po.po_number ?? po.purchase_order_id ?? "").trim();
    if (!poNo) {
      warnings.push(`Skipped Zepto PO with no identifier`);
      continue;
    }

    const poDate = zEpochOrIso(po.poDate ?? po.po_date ?? po.createdAt ?? po.created_at);
    const expiryDate = zEpochOrIso(po.expiryDate ?? po.expiry_date ?? po.deliveryDate ?? po.delivery_date);
    const totalQty = Math.max(0, Math.round(Number(po.totalQty ?? po.total_qty ?? po.poQty ?? po.quantity ?? po.totalQuantity ?? 0) || 0));
    const grnQty = Math.max(0, Math.round(Number(po.grnQty ?? po.grn_qty ?? po.receivedQty ?? po.received_qty ?? 0) || 0));
    const totalValue = Number(po.poValue ?? po.totalValue ?? po.total_value ?? po.value ?? po.amount ?? 0) || null;
    const statusRaw = String(po.status ?? po.poStatus ?? po.state ?? "");
    const status = mapZeptoLiveStatus(statusRaw, grnQty, totalQty);

    type LineSpec = { code: string; name: string; qty: number; unitPrice: number | null; rawData: Prisma.InputJsonValue };
    let lineSpecs: LineSpec[];

    const apiLines = extractZeptoLines(po);
    if (apiLines && apiLines.length > 0) {
      lineSpecs = apiLines.map((line, i) => {
        const rawCode = String(line.skuCode ?? line.sku_code ?? line.itemCode ?? line.item_code ?? line.productCode ?? line.product_code ?? "").trim();
        const rawName = String(line.skuName ?? line.sku_name ?? line.itemName ?? line.item_name ?? line.productName ?? line.product_name ?? "").trim();
        const code = rawCode ||
          (rawName ? "ZEP-" + rawName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24).replace(/^-|-$/g, "") : "") ||
          `ZEP-${poNo.replace(/[^A-Z0-9]/gi, "").slice(0, 12)}-L${i}`;
        const name = rawName || code;
        const qty = Math.max(0, Math.round(Number(line.quantity ?? line.qty ?? line.orderedQty ?? line.ordered_qty ?? 0) || 0));
        const unitPrice = Number(line.unitPrice ?? line.unit_price ?? line.price ?? null) || null;
        return { code, name, qty, unitPrice, rawData: line as Prisma.InputJsonValue };
      });
    } else {
      const summaryCode = `ZEP-SUMM-${poNo.replace(/[^A-Z0-9]/gi, "").slice(0, 16)}`;
      const summaryName = `Zepto PO ${poNo}${totalQty > 0 ? ` (${totalQty} units)` : ""}`;
      const unitPrice = totalValue && totalQty > 0 ? Math.round((totalValue / totalQty) * 100) / 100 : null;
      lineSpecs = [{ code: summaryCode, name: summaryName, qty: Math.max(1, totalQty), unitPrice, rawData: po as Prisma.InputJsonValue }];
      warnings.push(`PO ${poNo}: API returned no line items — 1 summary line created (qty=${totalQty}, value=${totalValue ?? "?"}).`);
    }

    const resolvedLines: { skuId: string; channelSkuCode: string | null; requestedQty: number; unitPrice: number | null; rawData: Prisma.InputJsonValue }[] = [];
    for (const spec of lineSpecs) {
      const { id: skuId, created } = await resolveOrCreateZeptoSku(spec.code, spec.name, skuCache);
      if (created) skusCreated++;
      resolvedLines.push({ skuId, channelSkuCode: spec.code, requestedQty: spec.qty, unitPrice: spec.unitPrice, rawData: spec.rawData });
    }

    const externalId = `zepto:${poNo}`;
    await prisma.$transaction(async (tx: typeof prisma) => {
      const dbPo = await tx.purchaseOrder.upsert({
        where: { externalId },
        create: {
          channelId, externalId, source: "ZEPTO", channelPoNumber: poNo, status,
          poDate, requestedDeliveryDate: expiryDate, totalRequestedValue: totalValue,
          rawData: po as Prisma.InputJsonValue, rawEmailSubject: `Zepto PO ${poNo}`,
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
        tx, entityType: "PurchaseOrder", entityId: dbPo.id, action: "ZEPTO_IMPORTED",
        performedBy: actorLabel,
        changes: { poNumber: poNo, lines: resolvedLines.length, totalValue, grnQty, status },
      });
    });

    posUpserted++;
    lineItems += resolvedLines.length;
    poNumbers.push(poNo);
  }

  return {
    source: "zepto",
    fileName: `zepto-live-${pos.length}-pos`,
    headers: [],
    fieldMap: {},
    unmappedHeaders: [],
    totalRows: pos.length,
    posUpserted,
    lineItems,
    skusCreated,
    poNumbers,
    warnings,
  };
}

async function getZeptoChannelId(): Promise<string> {
  const existing =
    (await prisma.channel.findFirst({ where: { name: "Zepto" } })) ??
    (await prisma.channel.findUnique({ where: { emailDomain: "zeptonow.com" } }));
  if (existing) return existing.id;
  const created = await prisma.channel.create({
    data: {
      name: "Zepto",
      emailDomain: "zeptonow.com",
      tier: "A",
      fillRateCommitment: 95,
      deliverySlaHours: 24,
      logoColor: "#7B2D8E", // Zepto purple
      grnViaEmail: true,
    },
  });
  return created.id;
}

/** Map a Zepto PO state + received quantities to our pipeline status. */
function mapStatus(rawState: string, totalReceived: number, allReceived: boolean): PoStatus {
  if (allReceived) return "CLOSED"; // fully delivered + GRN'd
  if (totalReceived > 0) return "GRN_RECEIVED"; // partially received
  if (/cancel|expired|reject/.test(rawState)) return "ON_HOLD";
  return "PENDING_REVIEW"; // open / new → still to allocate
}

function skuCodeFor(itemCode: string | undefined, itemName: string | undefined, stableKey: string): string {
  if (itemCode && itemCode.trim()) return itemCode.trim();
  if (itemName && itemName.trim()) {
    return "ZEP-" + itemName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24);
  }
  return `ZEP-SUMM-${stableKey.replace(/[^A-Z0-9]/gi, "-").slice(0, 20)}`;
}

/**
 * Ingest a parsed Zepto PO sheet into the PO pipeline. Idempotent per PO number.
 * Mirrors the Blinkit ingest (same field resolution, SKU upserts, GRN handling)
 * but writes source="ZEPTO" / externalId "zepto:<poNo>" / channel "Zepto".
 */
export async function ingestZeptoDump(
  sheet: ParsedSheet,
  fileName: string,
  actorLabel = "Zepto import",
): Promise<IngestSummary> {
  const channelId = await getZeptoChannelId();
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

  // Pre-resolve / create SKUs using stable "${poNo}:${localLineIdx}" keys so both
  // this pass and the per-group lineData pass below produce identical codes.
  const skuIdByCode = new Map<string, string>();
  let skusCreated = 0;
  for (const [gPoNo, gRows] of groups) {
    for (let li = 0; li < gRows.length; li++) {
      const row = gRows[li]!;
      const stableKey = `${gPoNo}:${li}`;
      const code = skuCodeFor(get(row, "itemCode"), get(row, "itemName"), stableKey);
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
            category: (get(row, "category") ?? "Zepto").trim() || "Zepto",
            uom: (get(row, "uom") ?? "unit").trim() || "unit",
          },
        });
        skuIdByCode.set(code, created.id);
        skusCreated++;
      }
    }
  }

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
      const received =
        remainingRaw != null ? Math.max(0, Math.min(ordered, ordered - Math.round(remainingRaw))) : 0;
      totalReceived += received;
      const unit = toNumber(get(row, "unitPrice")) ?? toNumber(get(row, "mrp"));
      const lineVal = toNumber(get(row, "lineValue")) ?? (unit != null ? unit * ordered : null);
      if (lineVal != null) total += lineVal;
      const skuId = skuIdByCode.get(code);
      if (!skuId) {
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

    const externalId = `zepto:${poNo}`;
    await prisma.$transaction(async (tx: typeof prisma) => {
      const po = await tx.purchaseOrder.upsert({
        where: { externalId },
        create: {
          channelId,
          externalId,
          source: "ZEPTO",
          channelPoNumber: poNo,
          status,
          poDate: poDate ?? undefined,
          requestedDeliveryDate: deliveryDate ?? undefined,
          totalRequestedValue: total || null,
          rawData: head as Prisma.InputJsonValue,
          rawEmailSubject: `Zepto PO ${poNo}`,
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

      // Replace line items (idempotent re-import)
      await tx.poLineItem.deleteMany({ where: { poId: po.id } });
      for (const { line } of lineData) {
        await tx.poLineItem.create({ data: { ...line, poId: po.id } });
      }

      // Replace GRN (received quantities), stored as a PORTAL GRN.
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
        action: "ZEPTO_IMPORTED",
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
    source: "zepto",
    fileName,
    headers: sheet.headers,
    fieldMap,
    unmappedHeaders,
    totalRows: sheet.rows.length,
    posUpserted,
    lineItems,
    skusCreated,
    poNumbers,
    warnings,
  };
}
