import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/services/audit";
import type { ParsedSheet } from "@/lib/integrations/blinkit/parse";
import { resolveFields, toNumber, toDate, type FieldMap } from "@/lib/integrations/blinkit/fields";

export interface IngestSummary {
  source: "blinkit";
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

async function getBlinkitChannelId(): Promise<string> {
  const existing =
    (await prisma.channel.findFirst({ where: { name: "Blinkit" } })) ??
    (await prisma.channel.findUnique({ where: { emailDomain: "blinkit.com" } }));
  if (existing) return existing.id;
  const created = await prisma.channel.create({
    data: {
      name: "Blinkit",
      emailDomain: "blinkit.com",
      tier: "A",
      fillRateCommitment: 95,
      deliverySlaHours: 24,
      logoColor: "#F8CB46",
      grnViaEmail: true,
    },
  });
  return created.id;
}

type PoStatus =
  | "PENDING_REVIEW" | "PRIORITISED" | "ALLOCATED" | "APPROVED" | "DISPATCHED"
  | "DELIVERED" | "GRN_RECEIVED" | "CLOSED" | "DISCREPANCY" | "ON_HOLD";

/** Map Blinkit po_state + received quantities to our pipeline status. */
function mapStatus(rawState: string, totalReceived: number, allReceived: boolean): PoStatus {
  if (allReceived) return "CLOSED"; // fully delivered + GRN'd
  if (totalReceived > 0) return "GRN_RECEIVED"; // partially received
  if (/cancel|expired/.test(rawState)) return "ON_HOLD";
  return "PENDING_REVIEW"; // scheduled / unscheduled / open → still to allocate
}

function skuCodeFor(itemCode: string | undefined, itemName: string | undefined, idx: number): string {
  if (itemCode && itemCode.trim()) return itemCode.trim();
  if (itemName && itemName.trim()) {
    return "BLK-" + itemName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24);
  }
  return `BLK-ROW-${idx}`;
}

/** Ingest a parsed Blinkit PO dump into the PO pipeline. Idempotent per PO number. */
export async function ingestBlinkitDump(
  sheet: ParsedSheet,
  fileName: string,
  actorLabel = "Blinkit import",
): Promise<IngestSummary> {
  const channelId = await getBlinkitChannelId();
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

  // Manufacturer filter — this partnersbiz account exposes POs for two manufacturers
  // (HBMK Global + Beyoutiful Consumer) under the same vendor entity. Keep only the
  // configured one (default: Beyoutiful).
  const mfgFilter = env.BLINKIT_MANUFACTURER_FILTER.trim().toLowerCase();
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

  // Pre-resolve / create SKUs for every distinct code among surviving POs.
  const skuIdByCode = new Map<string, string>();
  let skusCreated = 0;
  let idx = 0;
  for (const row of survivingRows) {
    idx++;
    const code = skuCodeFor(get(row, "itemCode"), get(row, "itemName"), idx);
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
          category: (get(row, "category") ?? "Blinkit").trim() || "Blinkit",
          uom: (get(row, "uom") ?? "unit").trim() || "unit",
        },
      });
      skuIdByCode.set(code, created.id);
      skusCreated++;
    }
  }

  let posUpserted = 0;
  let lineItems = 0;
  const poNumbers: string[] = [];

  let gi = 0;
  for (const [poNo, rows] of groups) {
    gi++;
    const head = rows[0]!;
    const poDate = toDate(get(head, "poDate"));
    // appointment_date is almost always empty in Blinkit exports; fall back to expiry_date.
    const deliveryDate =
      toDate(head["appointment_date"]) ??
      toDate(head["expiry_date"]) ??
      toDate(get(head, "deliveryDate"));

    const rawStatus = (get(head, "status") ?? "").trim().toLowerCase();

    let total = 0;
    let totalReceived = 0;
    const lineData = rows.map((row, i) => {
      const code = skuCodeFor(get(row, "itemCode"), get(row, "itemName"), gi * 10000 + i);
      const ordered = Math.max(0, Math.round(toNumber(get(row, "quantity")) ?? 0));
      const remainingRaw = toNumber(get(row, "remaining"));
      // received = ordered - remaining (when remaining is known and <= ordered)
      const received =
        remainingRaw != null ? Math.max(0, Math.min(ordered, ordered - Math.round(remainingRaw))) : 0;
      totalReceived += received;
      const unit = toNumber(get(row, "unitPrice")) ?? toNumber(get(row, "mrp"));
      const lineVal = toNumber(get(row, "lineValue")) ?? (unit != null ? unit * ordered : null);
      if (lineVal != null) total += lineVal;
      const skuId = skuIdByCode.get(code)!;
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
    });

    const allReceived = lineData.length > 0 && lineData.every((l) => l.received >= l.line.requestedQty);
    const status = mapStatus(rawStatus, totalReceived, allReceived);
    const hasGrn = totalReceived > 0;

    const externalId = `blinkit:${poNo}`;
    await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.upsert({
        where: { externalId },
        create: {
          channelId,
          externalId,
          source: "BLINKIT",
          channelPoNumber: poNo,
          status,
          poDate: poDate ?? undefined,
          requestedDeliveryDate: deliveryDate ?? undefined,
          totalRequestedValue: total || null,
          rawData: head as Prisma.InputJsonValue,
          rawEmailSubject: `Blinkit PO ${poNo}`,
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

      // Replace GRN (received quantities) — partnersbiz reports remaining qty per SKU,
      // so received = ordered - remaining. Stored as a PORTAL GRN so PO detail shows it.
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
        action: "BLINKIT_IMPORTED",
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
    source: "blinkit",
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
