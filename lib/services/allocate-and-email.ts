import "server-only";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import { sendPoPreparationEmail } from "@/lib/integrations/po-test-email";
import type { EmailAttachment } from "@/lib/integrations/po-test-email";
import { getPoDocuments, extractGstinFromPdf } from "@/lib/services/po-documents";
import { resolveDispatchFromGstins } from "@/lib/services/po-documents-helpers";
import { resolveInternalSku } from "@/lib/services/sku-resolver";
import { getLocationRecipients } from "@/lib/services/app-settings";
import { validatePoTaxables } from "@/lib/services/taxable-validation";
import { claimPo, PoClaimedError } from "@/lib/services/po-claim";

const FACILITY_KEYS = [
  "facilityname", "facility_name", "facility", "warehouse",
  "outlet", "store", "dcname", "dc", "destination",
];
const DISPATCH_KEYS = [
  "dispatchfrom", "dispatch_from", "sourcewh", "source_wh",
  "sourcecode", "fromwh", "fromwarehouse", "senderfacility",
];

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

      const firstLineRaw = po.lineItems[0]?.rawData;
      const location =
        extractRaw(po.rawData, FACILITY_KEYS) !== "—"
          ? extractRaw(po.rawData, FACILITY_KEYS)
          : extractRaw(firstLineRaw, FACILITY_KEYS);

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
            contentType: "application/pdf",
          });
          try {
            const gstins = await extractGstinFromPdf(docs.pdf.content);
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
            const channelCode = l.channelSkuCode ?? l.sku.internalCode;
            const sku = l.channelSkuCode
              ? resolveInternalSku(po.source, l.channelSkuCode)
              : channelCode;
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

  return { emailMessageId };
}
