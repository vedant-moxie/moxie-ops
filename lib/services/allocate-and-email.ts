import "server-only";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import { sendPoPreparationEmail } from "@/lib/integrations/po-test-email";
import type { EmailAttachment } from "@/lib/integrations/po-test-email";
import { getPoDocuments, extractGstinsFromDoc, resolveDispatchFromForPo } from "@/lib/services/po-documents";
import { resolveDispatchFromGstins } from "@/lib/services/po-documents-helpers";
import { resolveLineInternalSku, eanFromRaw, pvIdFromRaw } from "@/lib/services/sku-resolver";
import { mapEansToInternal } from "@/lib/services/sku-ean-resolver";
import { ensureSkuMasterFresh } from "@/lib/services/sku-master";
import { getLocationRecipients, getPoEmailRecipients } from "@/lib/services/app-settings";
import { nextEmailRef } from "@/lib/services/email-ref-counter";
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

// Location/WH for the email — the precise destination warehouse, tried in priority
// order (NOT first-key-wins like extractRaw). The full descriptive warehouse name
// (Nykaa `warehouse_location`="NWL-Nykaa Warehouse Lucknow") is preferred over a
// short code (Nykaa `location`="NWL", Zepto `location`="MUM-DRY-MH3"); falls back
// to facility/outlet/city. Keys are matched case/punctuation-insensitively.
export const LOCATION_PRIORITY = [
  "warehouselocation", "warehousename", "warehousedescription", "warehousedesc",
  "deliverylocation", "shiptolocation",
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
  /** True when the allocation saved but the email send threw (after retries) — so the
   *  caller can show "allocated but not emailed" instead of a silent success. */
  emailFailed?: boolean;
  /** The send error message (when emailFailed). */
  emailError?: string;
  /** The reference issued for this PO's prep email (stored on the PO). */
  emailRef?: string | null;
  /** True when the allocation saved but the email reached no one (no recipients) — the
   *  PO is flagged HELD and awaits a recipient fix + resend from the preview. */
  heldNoRecipients?: boolean;
  /** Why the email was held (shown in the resend preview banner). */
  emailHoldReason?: string;
}

/** Operator-edited email fields from the review/preview step. */
export interface PoEmailOverrides {
  bodyHtml?: string;
  /** Free-text subject; defaults to the saved template subject when omitted. */
  subject?: string;
  /** Reuse this reference verbatim instead of issuing a new one (resend). */
  presetRef?: string;
  /** Operator-edited To recipients (plain emails). Overrides location/global resolution
   *  — used by the resend-from-preview flow to fix an undelivered PO's recipients. */
  to?: string[];
  /** Operator-edited Cc recipients (plain emails). */
  cc?: string[];
}

export interface PoEmailSendResult {
  emailMessageId: string | null;
  emailFailed: boolean;
  emailError?: string;
  emailRef?: string | null;
  mismatchWithheld?: boolean;
  mismatches?: { sku: string; channelSkuCode: string | null; expected: number | null; actual: number | null; reason: string }[];
  /** True when the email was withheld because no recipients resolved — the PO is
   *  flagged (emailStatus=HELD) and awaits a recipient fix + resend, never misrouted. */
  heldNoRecipients?: boolean;
  /** Reason text when heldNoRecipients (shown in the resend preview banner). */
  emailHoldReason?: string;
}

export async function allocateAndEmailPo(
  poId: string,
  opts: AllocateOptions,
  actor: { id: string; label: string } = { id: "system", label: "system" },
  acknowledgeMismatch = false,
  /** Operator-edited email fields (from the review/preview modal). */
  emailOverrides?: PoEmailOverrides,
): Promise<AllocateResult> {
  await ensureSkuMasterFresh();
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

  // Build and send the PO-preparation email (extracted so a resend can reuse it).
  const emailRes = await buildAndSendPoEmail(poId, { acknowledgeMismatch, emailOverrides, actorLabel });
  // Price-mismatch withheld → allocation is saved but no email/WMS push.
  if (emailRes.mismatchWithheld) {
    return { emailMessageId: null, mismatchWithheld: true, mismatches: emailRes.mismatches };
  }
  const emailMessageId = emailRes.emailMessageId;

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
          const resolved = await resolveDispatchFromForPo({ ...wmsPo, id: poId });
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
                pvId: pvIdFromRaw(l.rawData),
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

  return {
    emailMessageId,
    emailFailed: emailRes.emailFailed,
    emailError: emailRes.emailError,
    emailRef: emailRes.emailRef,
    heldNoRecipients: emailRes.heldNoRecipients,
    emailHoldReason: emailRes.emailHoldReason,
  };
}

/**
 * Build and send the PO-preparation email for an ALREADY-PERSISTED allocation.
 * Reads the PO's current approved quantities, runs the price-mismatch gate (unless
 * acknowledged), fetches the channel docs, resolves dispatch-from + recipients, and
 * sends — with bounded retry inside the transport. On success it records the issued
 * reference (`emailRef`) and `emailSentAt` on the PO so the reference stays visible.
 *
 * Used by both the allocate flow (after the persist transaction) and the resend
 * endpoint (no re-allocation). A send failure is RETURNED (`emailFailed`), never
 * swallowed, so callers can report "allocated but not emailed".
 */
export async function buildAndSendPoEmail(
  poId: string,
  opts: {
    acknowledgeMismatch?: boolean;
    emailOverrides?: PoEmailOverrides;
    actorLabel?: string;
  } = {},
): Promise<PoEmailSendResult> {
  const actorLabel = opts.actorLabel ?? "system";
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      channelPoNumber: true,
      rawData: true,
      source: true,
      emailRef: true,
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
  if (!po) return { emailMessageId: null, emailFailed: true, emailError: "PO not found" };

  // Price-mismatch gate: validate channel prices vs the SKU-master rate sheet.
  // Withhold the email (allocation already saved) unless the caller acknowledged.
  if (!opts.acknowledgeMismatch) {
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
      return { emailMessageId: null, emailFailed: false, mismatchWithheld: true, mismatches };
    }
  }

  // The PO's stable email reference — reuse the preset (explicit resend) or the PO's
  // stored ref, else issue a new one on first attempt. Hoisted so the catch can persist
  // it against a FAILED send. Kept the same across sent / held / failed / resend.
  let ref: string | undefined = opts.emailOverrides?.presetRef ?? po.emailRef ?? undefined;

  try {
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

    // Resolve recipients, in priority order:
    //   1. operator-edited recipients from the resend-preview (explicit override)
    //   2. the PO's dispatch-location list (RGL NCR/BLR/MUM)
    //   3. the global fallback list — CONFIGURED addresses only (never a personal inbox)
    // If all three yield nothing, we do NOT send: the email would reach no one, so we
    // withhold it and flag the PO (emailStatus=HELD) for a recipient fix + resend.
    let toList: string[] | undefined;
    let ccList: string[] | undefined;
    if (opts.emailOverrides?.to && opts.emailOverrides.to.length > 0) {
      toList = opts.emailOverrides.to;
      ccList = opts.emailOverrides.cc ?? [];
    } else if (dispatchFrom && dispatchFrom !== "—") {
      const locRecipients = await getLocationRecipients(dispatchFrom);
      if (locRecipients) {
        toList = locRecipients.to;
        ccList = locRecipients.cc;
      }
    }
    if (!toList || toList.length === 0) {
      const g = await getPoEmailRecipients();
      if (g.to.length > 0) {
        toList = g.to;
        ccList = g.cc;
      }
    }

    // Issue the next reference from the series NOW (first attempt only) and keep it
    // bound to the PO across every outcome (sent / held / failed) so a resend always
    // carries the same number.
    if (!ref) ref = (await nextEmailRef()).ref;

    // No recipients anywhere → withhold + flag instead of misrouting. Persist the ref
    // and the hold reason so the PO surfaces in the UI with a resend-from-preview action.
    if (!toList || toList.length === 0) {
      const reason =
        dispatchFrom && dispatchFrom !== "—"
          ? `No recipients configured for dispatch location "${dispatchFrom}"`
          : "Dispatch location could not be resolved and no global recipients are configured";
      await prisma.purchaseOrder.update({
        where: { id: poId },
        data: { emailRef: ref, emailStatus: "HELD", emailHoldReason: reason },
      }).catch((err) => console.error("[allocate-and-email] failed to persist held state:", err));
      await writeAudit({
        entityType: "PurchaseOrder",
        entityId: poId,
        action: "EMAIL_WITHHELD_NO_RECIPIENTS",
        performedBy: actorLabel,
        changes: { ref, dispatchFrom, reason },
      }).catch(() => {});
      console.warn(`[allocate-and-email] email withheld for PO ${poId} [${ref}]: ${reason}`);
      return { emailMessageId: null, emailFailed: false, heldNoRecipients: true, emailHoldReason: reason, emailRef: ref };
    }

    const result = await sendPoPreparationEmail({
      poNumber: po.channelPoNumber ?? poId,
      channel: po.channel.name,
      location,
      dispatchFrom,
      to: toList,
      cc: ccList,
      lines: po.lineItems
        .map((l) => {
          // Quantities are already persisted (approvedQty). A persisted 0 means the
          // line was removed/zeroed in the allocator → keep it 0 so the qty>0 filter
          // drops it. Only fall back to requested when nothing was ever allocated
          // (approvedQty is null), e.g. a resend of a never-allocated PO.
          const qty: number = l.approvedQty ?? l.requestedQty;
          const sku = resolveLineInternalSku({
            source: po.source,
            channelCode: l.channelSkuCode ?? l.sku.internalCode,
            pvId: pvIdFromRaw(l.rawData),
            ean: eanFromRaw(l.rawData),
            eanMap,
          });
          return { sku, qty };
        })
        .filter((l) => l.qty > 0),
      attachments,
      bodyHtmlOverride: opts.emailOverrides?.bodyHtml,
      subjectOverride: opts.emailOverrides?.subject,
      // Use the ref we resolved + persisted above so sent/held/failed all agree.
      presetRef: ref,
    });

    // Delivered → record ref + sent time, clear any prior hold, mark SENT.
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { emailRef: result.ref, emailSentAt: new Date(), emailStatus: "SENT", emailHoldReason: null },
    }).catch((err) => console.error("[allocate-and-email] failed to persist emailRef:", err));
    await writeAudit({
      entityType: "PurchaseOrder",
      entityId: poId,
      action: "EMAIL_SENT",
      performedBy: actorLabel,
      changes: { ref: result.ref, messageId: result.messageId, to: result.to, cc: result.cc },
    }).catch(() => {});

    return { emailMessageId: result.messageId, emailFailed: false, emailRef: result.ref };
  } catch (err) {
    const emailError = err instanceof Error ? err.message : String(err);
    console.error(`[allocate-and-email] email send failed for PO ${poId}:`, err);
    // Persist the ref + FAILED so the PO surfaces for resend and keeps its number.
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { emailRef: ref, emailStatus: "FAILED", emailHoldReason: emailError.slice(0, 500) },
    }).catch((e) => console.error("[allocate-and-email] failed to persist failed state:", e));
    await writeAudit({
      entityType: "PurchaseOrder",
      entityId: poId,
      action: "EMAIL_FAILED",
      performedBy: actorLabel,
      changes: { ref, error: emailError },
    }).catch(() => {});
    return { emailMessageId: null, emailFailed: true, emailError };
  }
}
