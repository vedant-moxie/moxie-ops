import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

export interface IngestSummary {
  source: "nykaa";
  fileName: string;
  totalRows: number;
  posUpserted: number;
  lineItems: number;
  skusCreated: number;
  poNumbers: string[];
  warnings: string[];
}

type PoStatus =
  | "PENDING_REVIEW" | "PRIORITISED" | "ALLOCATED" | "APPROVED" | "DISPATCHED"
  | "DELIVERED" | "GRN_RECEIVED" | "CLOSED" | "DISCREPANCY" | "ON_HOLD";

/**
 * Map a Nykaa PO status string + received quantities to our pipeline status.
 * Driven primarily by per-SKU received qty (mirrors the Zepto live mapping):
 * "PENDING_GRN" must NOT trigger GRN_RECEIVED — it means awaiting GRN.
 */
function mapNykaaStatus(status: string, totalReceivedQty: number, totalQty: number): PoStatus {
  const s = status.toLowerCase();
  if (s.includes("cancel") || s.includes("expir") || s.includes("reject")) return "ON_HOLD";
  if (totalReceivedQty > 0) {
    if (totalReceivedQty >= totalQty && totalQty > 0) return "CLOSED";
    return "GRN_RECEIVED";
  }
  if (s.includes("dispatch") || s.includes("shipped") || s.includes("intransit") || s.includes("in_transit")) return "DISPATCHED";
  if (s.includes("approved") || s.includes("confirmed") || s.includes("acknowledged")) return "APPROVED";
  if (s.includes("complet") || s.includes("delivered") || s === "grn_received") return "GRN_RECEIVED";
  return "PENDING_REVIEW";
}

function epochOrIso(v: unknown): Date | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return new Date(n > 1e11 ? n : n * 1000);
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const NYKAA_LINE_KEYS = ["lineItems", "line_items", "items", "skus", "products", "poItems", "orderItems", "lines"];

function extractNykaaLines(po: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const k of NYKAA_LINE_KEYS) {
    const v = po[k];
    if (Array.isArray(v) && v.some(isRec)) return v.filter(isRec);
  }
  return null;
}

async function getOrCreateNykaaChannel(): Promise<string> {
  const existing =
    (await prisma.channel.findFirst({ where: { name: "Nykaa" } })) ??
    (await prisma.channel.findUnique({ where: { emailDomain: "nykaa.com" } }));
  if (existing) return existing.id;
  const created = await prisma.channel.create({
    data: {
      name: "Nykaa",
      emailDomain: "nykaa.com",
      tier: "A",
      fillRateCommitment: 95,
      deliverySlaHours: 24,
      logoColor: "#fc2779", // Nykaa pink
      grnViaEmail: true,
    },
  });
  return created.id;
}

async function resolveOrCreateNykaaSku(
  code: string,
  name: string,
  cache: Map<string, string>,
): Promise<{ id: string; created: boolean }> {
  const hit = cache.get(code);
  if (hit) return { id: hit, created: false };
  const existing = await prisma.sku.findUnique({ where: { internalCode: code } });
  if (existing) {
    cache.set(code, existing.id);
    return { id: existing.id, created: false };
  }
  const created = await prisma.sku.create({ data: { internalCode: code, name, category: "Nykaa", uom: "unit" } });
  cache.set(code, created.id);
  return { id: created.id, created: true };
}

/**
 * Ingest raw Nykaa PO objects (from the seller-portal grid endpoint) into the
 * pipeline. Handles camelCase/snake_case field conventions. When the list
 * endpoint returns header-only rows, creates a single summary PoLineItem so the
 * PO is visible and Prisma never receives an undefined skuId. Idempotent per PO
 * (externalId = "nykaa:<poNo>"). Mirrors ingestLiveZeptoPOs.
 */
export async function ingestLiveNykaaPOs(
  pos: Record<string, unknown>[],
  actorLabel = "Nykaa sync",
): Promise<IngestSummary> {
  const channelId = await getOrCreateNykaaChannel();
  const warnings: string[] = [];
  const poNumbers: string[] = [];
  let posUpserted = 0;
  let lineItems = 0;
  let skusCreated = 0;
  const skuCache = new Map<string, string>();

  for (const po of pos) {
    const poNo = String(
      po.poNumber ?? po.po_number ?? po.poId ?? po.po_id ?? po.id ?? po.purchaseOrderNumber ?? "",
    ).trim();
    if (!poNo) {
      warnings.push(`Skipped Nykaa PO with no identifier`);
      continue;
    }

    const poDate = epochOrIso(po.poDate ?? po.po_date ?? po.createdAt ?? po.created_at ?? po.orderDate);
    const expiryDate = epochOrIso(
      po.expiryDate ?? po.expiry_date ?? po.deliveryDate ?? po.delivery_date ?? po.appointmentDate,
    );
    const totalQty = Math.max(
      0,
      Math.round(Number(po.totalQty ?? po.total_qty ?? po.quantity ?? po.totalQuantity ?? 0) || 0),
    );
    const totalValue = Number(po.poValue ?? po.totalValue ?? po.total_value ?? po.value ?? po.amount ?? 0) || null;
    const statusRaw = String(po.status ?? po.poStatus ?? po.po_status ?? po.state ?? "");

    type LineSpec = {
      code: string;
      name: string;
      qty: number;
      receivedQty: number;
      unitPrice: number | null;
      rawData: Prisma.InputJsonValue;
    };
    let lineSpecs: LineSpec[];

    const apiLines = extractNykaaLines(po);
    if (apiLines && apiLines.length > 0) {
      lineSpecs = apiLines.map((line, i) => {
        const rawCode = String(
          line.skuCode ?? line.sku_code ?? line.itemCode ?? line.item_code ?? line.productCode ?? line.product_code ?? line.styleId ?? line.fsn ?? "",
        ).trim();
        const rawName = String(
          line.skuName ?? line.sku_name ?? line.itemName ?? line.item_name ?? line.productName ?? line.product_name ?? line.title ?? "",
        ).trim();
        const code =
          rawCode ||
          (rawName ? "NYK-" + rawName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24).replace(/^-|-$/g, "") : "") ||
          `NYK-${poNo.replace(/[^A-Z0-9]/gi, "").slice(0, 12)}-L${i}`;
        const name = rawName || code;
        const qty = Math.max(
          0,
          Math.round(Number(line.quantity ?? line.qty ?? line.orderedQty ?? line.ordered_qty ?? line.poQty ?? line.po_qty ?? 0) || 0),
        );
        const grnRaw = line.grnQty ?? line.grn_qty ?? line.receivedQty ?? line.received_qty ?? null;
        const receivedQty = grnRaw != null ? Math.max(0, Math.round(Number(grnRaw) || 0)) : 0;
        const unitPrice = Number(line.unitPrice ?? line.unit_price ?? line.price ?? line.costPrice ?? null) || null;
        return { code, name, qty, receivedQty, unitPrice, rawData: line as Prisma.InputJsonValue };
      });
    } else {
      const summaryCode = `NYK-SUMM-${poNo.replace(/[^A-Z0-9]/gi, "").slice(0, 16)}`;
      const summaryName = `Nykaa PO ${poNo}${totalQty > 0 ? ` (${totalQty} units)` : ""}`;
      const unitPrice = totalValue && totalQty > 0 ? Math.round((totalValue / totalQty) * 100) / 100 : null;
      lineSpecs = [
        { code: summaryCode, name: summaryName, qty: Math.max(1, totalQty), receivedQty: 0, unitPrice, rawData: po as Prisma.InputJsonValue },
      ];
      warnings.push(`PO ${poNo}: API returned no line items — 1 summary line created (qty=${totalQty}, value=${totalValue ?? "?"}).`);
    }

    const totalReceivedQty = lineSpecs.reduce((s, l) => s + l.receivedQty, 0);
    const status = mapNykaaStatus(statusRaw, totalReceivedQty, totalQty);

    const resolvedLines: {
      skuId: string;
      channelSkuCode: string | null;
      requestedQty: number;
      receivedQty: number;
      unitPrice: number | null;
      rawData: Prisma.InputJsonValue;
    }[] = [];
    for (const spec of lineSpecs) {
      const { id: skuId, created } = await resolveOrCreateNykaaSku(spec.code, spec.name, skuCache);
      if (created) skusCreated++;
      resolvedLines.push({
        skuId,
        channelSkuCode: spec.code,
        requestedQty: spec.qty,
        receivedQty: spec.receivedQty,
        unitPrice: spec.unitPrice,
        rawData: spec.rawData,
      });
    }

    const externalId = `nykaa:${poNo}`;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const dbPo = await tx.purchaseOrder.upsert({
        where: { externalId },
        create: {
          channelId, externalId, source: "NYKAA", channelPoNumber: poNo, status,
          poDate, requestedDeliveryDate: expiryDate, totalRequestedValue: totalValue,
          rawData: po as Prisma.InputJsonValue, rawEmailSubject: `Nykaa PO ${poNo}`,
          ...(poDate ? { createdAt: poDate } : {}),
        },
        update: {
          channelPoNumber: poNo, status, poDate, requestedDeliveryDate: expiryDate,
          totalRequestedValue: totalValue, rawData: po as Prisma.InputJsonValue,
        },
      });

      await tx.poLineItem.deleteMany({ where: { poId: dbPo.id } });
      for (const line of resolvedLines) {
        await tx.poLineItem.create({
          data: {
            poId: dbPo.id,
            skuId: line.skuId,
            channelSkuCode: line.channelSkuCode,
            requestedQty: line.requestedQty,
            unitPrice: line.unitPrice,
            rawData: line.rawData,
          },
        });
      }

      await tx.discrepancy.deleteMany({ where: { poId: dbPo.id } });
      await tx.grnRecord.deleteMany({ where: { poId: dbPo.id } });
      const grnLines = resolvedLines.filter((l) => l.receivedQty > 0);
      if (grnLines.length > 0) {
        const allReceived = totalReceivedQty >= totalQty && totalQty > 0;
        await tx.grnRecord.create({
          data: {
            poId: dbPo.id, source: "PORTAL", channelGrnNumber: null,
            status: allReceived ? "ACCEPTED" : "PENDING_RECONCILIATION",
            receivedAt: expiryDate ?? poDate,
            lineItems: {
              create: grnLines.map((l) => ({ skuId: l.skuId, receivedQty: l.receivedQty, rejectedQty: 0 })),
            },
          },
        });
      }

      await writeAudit({
        tx, entityType: "PurchaseOrder", entityId: dbPo.id, action: "NYKAA_IMPORTED",
        performedBy: actorLabel,
        changes: { poNumber: poNo, lines: resolvedLines.length, totalValue, totalReceivedQty, status },
      });
    });

    posUpserted++;
    lineItems += resolvedLines.length;
    poNumbers.push(poNo);
  }

  return {
    source: "nykaa",
    fileName: `nykaa-live-${pos.length}-pos`,
    totalRows: pos.length,
    posUpserted,
    lineItems,
    skusCreated,
    poNumbers,
    warnings,
  };
}
