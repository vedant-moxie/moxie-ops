import "server-only";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import { sendPoPreparationEmail } from "@/lib/integrations/po-test-email";
import type { EmailAttachment } from "@/lib/integrations/po-test-email";
import { getPoDocuments, extractGstinsFromDoc, resolveDispatchFromForPo } from "@/lib/services/po-documents";
import { resolveDispatchFromGstins } from "@/lib/services/po-documents-helpers";
import { resolveLineInternalSku, eanFromRaw } from "@/lib/services/sku-resolver";
import { mapEansToInternal } from "@/lib/services/sku-ean-resolver";
import { getLocationRecipients } from "@/lib/services/app-settings";
import { validatePoTaxables } from "@/lib/services/taxable-validation";
import { claimPo, PoClaimedError } from "@/lib/services/po-claim";
import { wmsConfigured, pushSalesOrder } from "@/lib/integrations/wms";
import { decrementWarehouseStock } from "@/lib/services/wms-stock-sync";
import { warehouseByDispatchFrom, type WarehouseInfo } from "@/lib/warehouses";
import { env } from "@/lib/env";

const FACILITY_KEYS = [
  "facilityname", "facility_name", "facility", "warehouse",
  "outlet", "store", "dcname", "dc", "destination",
];
const DISPATCH_KEYS = [
  "dispatchfrom", "dispatch_from", "sourcewh", "source_wh",
  "sourcecode", "fromwh", "fromwarehouse", "senderfacility",
];

/** Resolve WMS party code for a channel name. */
function resolveWmsPartyCode(channelName: string): string {
  const raw = env.WMS_PARTY_CODES;
  if (raw) {
    try {
      const map = JSON.parse(raw) as Record<string, string>;
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const entry = Object.entries(map).find(([k]) => norm(k) === norm(channelName));
      if (entry) return entry[1];
    } catch { /* ignore */ }
  }
  return env.WMS_DEFAULT_PARTY_CODE ?? channelName;
}

function extractRaw(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== "object") return "—";
  const data = obj as Record<string, unknown>;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const key of Object.keys(data)) {
    if (keys.includes(norm(key))) {
      const v = data[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "—";
}

// Location/WH for the email — the precise dock/warehouse code, tried in priority
// order (NOT first-key-wins like extractRaw): Zepto `location`="MUM-DRY-MH3",
// Nykaa `location`="KOL". Falls back to facility/outlet/city if those are absent.
export const LOCATION_PRIORITY = [
  "location", "locationcode", "dcname", "dc", "facilityname", "facility_name",
  "facility", "warehouse", "store", "outlet", "destination", "locationname", "city",
];
export function pickByPriority(obj: unknown, orderedKeys: string[]): string {
  if (!obj || typeof obj !== "object") return "—";
  const data = obj as Record<string, unknown>;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byNorm = new Map<string, unknown>();
  for (const k of Object.keys(data)) byNorm.set(norm(k), data[k]);
  for (const key of orderedKeys) {
    const v = byNorm.get(norm(key));
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "—";
}

export type AllocateOptions =
  // Full mode: allocate every line to its requestedQty, EXCEPT skuIds in `excludeSkuIds`
  // (removed during review — they get approvedQty 0 and are left out of the email).
  | { full: true; excludeSkuIds?: string[]; allocations?: never }
  | { full?: false; allocations: { skuId: string; approvedQty: number }[] };

/**
 * Persist per-SKU approved quantities for one PO, mark it ALLOCATED, write
 * an audit entry, and send the PO-preparation email.
 *
 * Pass `{ full: true }` to allocate every line to its requestedQty (bulk path).
 * Pass `{ allocations: [...] }` for an explicit per-SKU breakdown (per-PO path).
 *
 * Email failure is non-fatal — the allocation is already committed when it throws.
 *
 * Price-mismatch gate: before sending, the PO's line prices are validated against
 * the SKU-master rate sheet. If any line's channel price differs and the caller
 * did NOT set `acknowledgeMismatch`, the allocation is still saved but the email
 * is WITHHELD (and audited) — so a PO with wrong prices is never auto-emailed.
 */
export interface AllocateResult {
  emailMessageId: string | null;
  /** True when the email was held back because of an unacknowledged price mismatch. */
  mismatchWithheld?: boolean;
  /** The offending lines (when withheld), for the caller to surface. */
  mismatches?: { sku: string; channelSkuCode: string | null; expected: number | null; actual: number | null; reason: string }[];
}

export async function allocateAndEmailPo(
  poId: string,
  opts: AllocateOptions,
  actor: { id: string; label: string } = { id: "system", label: "system" },
  acknowledgeMismatch = false,
): Promise<AllocateResult> {
  const actorLabel = actor.label;
  // Resolve allocations: for full mode, fetch line items first
  let allocations: { skuId: string; approvedQty: number }[];
  if (opts.full) {
    const poPre = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: poId },
      select: { lineItems: { select: { skuId: true, requestedQty: true } } },
    });
    const excluded = new Set(opts.excludeSkuIds ?? []);
    // Removed SKUs get approvedQty 0 → excluded from the prep email (qty>0 filter).
    allocations = poPre.lineItems.map((l) => ({
      skuId: l.skuId,
      approvedQty: excluded.has(l.skuId) ? 0 : l.requestedQty,
    }));
  } else {
    allocations = opts.allocations;
  }

  // Persist in a transaction
  await prisma.$transaction(async (tx) => {
    // Double-allocation guard: atomically (re)assert the claim INSIDE the txn. If
    // another user holds a fresh claim, this throws and the whole txn rolls back —
    // so two people hitting send can never both allocate the same PO.
    const claim = await claimPo(poId, actor, tx);
    if (!claim.ok) throw new PoClaimedError(claim.claimedByLabel);

    for (const a of allocations) {
      await tx.poLineItem.updateMany({
        where: { poId, skuId: a.skuId },
        data: { approvedQty: a.approvedQty },
      });
    }
    await tx.purchaseOrder.update({
      where: { id: poId },
      // Allocation committed → release the claim (it's left the queue / re-openable).
      data: { status: "ALLOCATED", approvedBy: actorLabel, approvedAt: new Date(), claimedById: null, claimedByLabel: null, claimedAt: null },
    });
    await writeAudit({
      tx,
      entityType: "PurchaseOrder",
      entityId: poId,
      action: "ALLOCATED",
      performedBy: actorLabel,
      changes: { allocations },
    });
  });

  // Build and send the PO-preparation email
  let emailMessageId: string | null = null;
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      select: {
        channelPoNumber: true,
        rawData: true,
        source: true,
        channel: { select: { name: true } },
        lineItems: {
          select: {
            id: true,
            skuId: true,
            approvedQty: true,
            requestedQty: true,
            unitPrice: true,
            channelSkuCode: true,
            rawData: true,
            sku: { select: { internalCode: true } },
          },
        },
      },
    });

    // Price-mismatch gate: validate channel prices vs the SKU-master rate sheet.
    // Withhold the email (allocation already saved) unless the caller acknowledged.
    if (po && !acknowledgeMismatch) {
      const tax = validatePoTaxables(po);
      if (tax.hasTaxableMismatch) {
        const mismatches = tax.lines
          .filter((l) => l.mismatch)
          .map((l) => ({ sku: l.sku, channelSkuCode: l.channelSkuCode, expected: l.expected, actual: l.actual, reason: l.reason }));
        await writeAudit({
          entityType: "PurchaseOrder",
          entityId: poId,
          action: "EMAIL_WITHHELD_PRICE_MISMATCH",
          performedBy: actorLabel,
          changes: { mismatchCount: mismatches.length, mismatches },
        });
        console.warn(`[allocate-and-email] email withheld for PO ${poId}: ${mismatches.length} price mismatch(es)`);
        return { emailMessageId: null, mismatchWithheld: true, mismatches };
      }
    }

    if (po) {
      const allocMap = Object.fromEntries(allocations.map((a) => [a.skuId, a.approvedQty]));
      // Authoritative EAN→internal map (DB) so the email shows our WMS codes even
      // when the channel-code map can't resolve (e.g. Zepto's pvId-based zeptoCode).
      const eanMap = await mapEansToInternal(po.lineItems.map((l) => eanFromRaw(l.rawData))).catch(() => new Map<string, string>());

      const firstLineRaw = po.lineItems[0]?.rawData;
      const location =
        pickByPriority(po.rawData, LOCATION_PRIORITY) !== "—"
          ? pickByPriority(po.rawData, LOCATION_PRIORITY)
          : pickByPriority(firstLineRaw, LOCATION_PRIORITY);

      let dispatchFrom =
        extractRaw(po.rawData, DISPATCH_KEYS) !== "—"
          ? extractRaw(po.rawData, DISPATCH_KEYS)
          : extractRaw(firstLineRaw, DISPATCH_KEYS);

      const attachments: EmailAttachment[] = [];
      try {
        const docs = await getPoDocuments(po);
        if (docs.pdf) {
          attachments.push({
            filename: docs.pdf.filename,
            content: docs.pdf.content,
            contentType: docs.pdf.filename.toLowerCase().endsWith(".zip")
              ? "application/zip"
              : "application/pdf",
          });
          // Resolve dispatch-from from the supplier (Moxie) GSTIN on the PO doc.
          // Handles a PDF or a ZIP-of-PDF (Nykaa) — unzips and reads the inner PDF.
          try {
            const gstins = await extractGstinsFromDoc(docs.pdf.content, docs.pdf.filename);
            const resolved = resolveDispatchFromGstins(gstins);
            if (resolved.dispatchFrom) dispatchFrom = resolved.dispatchFrom;
            if (resolved.warning) console.warn("[allocate-and-email] dispatchFrom:", resolved.warning);
          } catch (err) {
            console.warn("[allocate-and-email] GSTIN extraction failed:", err);
          }
        }
        if (docs.excel) {
          const isCsv = docs.excel.filename.toLowerCase().endsWith(".csv");
          attachments.push({
            filename: docs.excel.filename,
            content: docs.excel.content,
            contentType: isCsv
              ? "text/csv"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          });
        }
        if (docs.warnings.length) {
          console.warn("[allocate-and-email] document fetch warnings:", docs.warnings);
        }
      } catch (err) {
        console.warn("[allocate-and-email] getPoDocuments failed:", err);
      }

      // Per-dispatch-location recipients; fall back to the global list (handled
      // inside sendPoPreparationEmail) when the location is unknown/unmapped.
      let toOverride: string[] | undefined;
      let ccOverride: string[] | undefined;
      if (dispatchFrom && dispatchFrom !== "—") {
        const locRecipients = await getLocationRecipients(dispatchFrom);
        if (locRecipients) {
          toOverride = locRecipients.to;
          ccOverride = locRecipients.cc;
          console.info(`[allocate-and-email] using ${dispatchFrom} recipients:`, {
            to: toOverride,
            cc: ccOverride,
          });
        } else {
          console.info(`[allocate-and-email] no recipients for "${dispatchFrom}", using global fallback`);
        }
      }

      const result = await sendPoPreparationEmail({
        poNumber: po.channelPoNumber ?? poId,
        channel: po.channel.name,
        location,
        dispatchFrom,
        to: toOverride,
        cc: ccOverride,
        lines: po.lineItems
          .map((l) => {
            const qty: number =
              allocMap[l.skuId] != null
                ? (allocMap[l.skuId] as number)
                : (l.approvedQty ?? 0) > 0
                  ? l.approvedQty!
                  : l.requestedQty;
            // Show the warehouse our internal/WMS code, not the raw channel id.
            // Resolve via channel-code map, then the line's EAN (covers Zepto, whose
            // channelSkuCode doesn't match the master's pvId-based zeptoCode).
            const sku = resolveLineInternalSku({
              source: po.source,
              channelCode: l.channelSkuCode ?? l.sku.internalCode,
              ean: eanFromRaw(l.rawData),
              eanMap,
            });
            return { sku, qty };
          })
          .filter((l) => l.qty > 0),
        attachments,
      });
      emailMessageId = result.messageId;
    }
  } catch (err) {
    console.error("[allocate-and-email] email send failed:", err);
  }

  // Subtract the allocation from the local per-warehouse stock mirror (so the
  // next PO immediately sees less free stock) and push a Sales Order to the
  // WMS to block the quantity there. Both are non-fatal.
  if (wmsConfigured()) {
    try {
      const wmsPo = await prisma.purchaseOrder.findUnique({
        where: { id: poId },
        select: {
          channelPoNumber: true,
          source: true,
          rawData: true,
          channel: { select: { name: true } },
          lineItems: {
            select: {
              skuId: true,
              approvedQty: true,
              unitPrice: true,
              sku: { select: { internalCode: true, name: true } },
              rawData: true,
            },
          },
        },
      });
      if (wmsPo) {
        // Shipping warehouse: GSTIN on the PO PDF first, rawData dispatch fields as fallback.
        let warehouse: WarehouseInfo | null = null;
        try {
          const resolved = await resolveDispatchFromForPo(wmsPo);
          if (resolved.dispatchFrom) warehouse = warehouseByDispatchFrom(resolved.dispatchFrom);
          if (resolved.warnings.length) {
            console.warn("[allocate-and-email] dispatch warehouse:", resolved.warnings);
          }
        } catch { /* fall through to rawData */ }
        if (!warehouse) {
          const firstRaw = wmsPo.lineItems[0]?.rawData;
          const dispatchLabel =
            extractRaw(wmsPo.rawData, DISPATCH_KEYS) !== "—"
              ? extractRaw(wmsPo.rawData, DISPATCH_KEYS)
              : extractRaw(firstRaw, DISPATCH_KEYS);
          if (dispatchLabel !== "—") warehouse = warehouseByDispatchFrom(dispatchLabel);
        }

        if (warehouse) {
          const wmsEanMap = await mapEansToInternal(wmsPo.lineItems.map((l) => eanFromRaw(l.rawData))).catch(() => new Map<string, string>());
          const allocLines = wmsPo.lineItems
            .filter((l) => (l.approvedQty ?? 0) > 0)
            .map((l) => ({
              // WMS expects our internal code (GCS200…), not the raw channel id.
              skuCode: resolveLineInternalSku({
                source: wmsPo.source,
                channelCode: l.sku.internalCode,
                ean: eanFromRaw(l.rawData),
                eanMap: wmsEanMap,
              }),
              skuDescription: l.sku.name,
              quantity: l.approvedQty!,
              mrp: l.unitPrice ?? 0,
              amount: (l.unitPrice ?? 0) * l.approvedQty!,
            }));

          if (allocLines.length > 0) {
            // 1. Local mirror: itna katt gaya — next allocation sees the reduced number.
            try {
              await decrementWarehouseStock(
                warehouse.code,
                allocLines.map((l) => ({ skuCode: l.skuCode, qty: l.quantity })),
              );
              await writeAudit({
                entityType: "PurchaseOrder",
                entityId: poId,
                action: "WAREHOUSE_STOCK_DEDUCTED",
                performedBy: actorLabel,
                changes: {
                  warehouseCode: warehouse.code,
                  lines: allocLines.map((l) => ({ sku: l.skuCode, qty: l.quantity })),
                },
              });
            } catch (err) {
              console.error("[allocate-and-email] local stock decrement failed:", err);
            }

            // 2. WMS sales order to lock the stock at the warehouse.
            const soId = await pushSalesOrder({
              orderNo: wmsPo.channelPoNumber ?? poId,
              orderDate: new Date().toISOString(),
              warehouseCode: warehouse.wmsCode,
              warehouseName: warehouse.wmsName,
              partyCode: resolveWmsPartyCode(wmsPo.channel.name),
              partyName: wmsPo.channel.name,
              lines: allocLines,
            });
            await writeAudit({
              entityType: "PurchaseOrder",
              entityId: poId,
              action: "WMS_SO_PUSHED",
              performedBy: actorLabel,
              changes: { salesorder_id: soId, warehouseCode: warehouse.code },
            });
            console.info(`[allocate-and-email] WMS SO ${soId} pushed for PO ${poId} (${warehouse.code})`);
          }
        } else {
          console.info("[allocate-and-email] WMS push skipped — shipping warehouse unresolved (no GSTIN match)");
        }
      }
    } catch (err) {
      console.error("[allocate-and-email] WMS SO push failed (non-fatal):", err);
    }
  }

  return { emailMessageId };
}
