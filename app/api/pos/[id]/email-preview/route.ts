import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildHtml } from "@/lib/integrations/po-test-email";
import { LOCATION_PRIORITY, pickByPriority } from "@/lib/services/allocate-and-email";
import { resolveLineInternalSku, eanFromRaw, pvIdFromRaw } from "@/lib/services/sku-resolver";
import { mapEansToInternal } from "@/lib/services/sku-ean-resolver";
import { ensureSkuMasterFresh } from "@/lib/services/sku-master";
import { resolveDispatchFromForPo } from "@/lib/services/po-documents";
import {
  getLocationRecipients,
  getPoEmailRecipients,
  getEmailTemplate,
  getEmailRedirect,
} from "@/lib/services/app-settings";
import { getSeries } from "@/lib/services/email-ref-counter";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Pending allocation the operator is reviewing — lets the preview reflect exactly
 * what will be sent, BEFORE anything is persisted.
 *  • `allocations`   — explicit per-SKU approved qty (single-PO allocator path).
 *  • `excludeSkuIds` — SKUs removed during bulk review; everything else = ordered qty.
 * When neither is given (GET), the stored approved/requested qty is used.
 */
interface PreviewOverrides {
  allocations?: { skuId: string; approvedQty: number }[];
  excludeSkuIds?: string[];
}

const overrideSchema = z.object({
  allocations: z
    .array(z.object({ skuId: z.string(), approvedQty: z.number().int().nonnegative() }))
    .optional(),
  excludeSkuIds: z.array(z.string()).optional(),
});

/**
 * Render the dispatch email for a PO exactly as it would be sent (greeting/intro/
 * SKU table/PO bullets/signature from the editable template, internal SKU codes,
 * resolved Location/WH + Dispatch-From + recipients) — WITHOUT sending and without
 * consuming a reference number. Shared by the GET (channel bulk-send) and POST
 * (allocation review, which passes the pending allocation) handlers.
 */
async function renderPreview(poId: string, overrides: PreviewOverrides) {
  await requireAuth();
  await ensureSkuMasterFresh();
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      channelPoNumber: true,
      source: true,
      rawData: true,
      status: true,
      emailRef: true,
      emailStatus: true,
      emailHoldReason: true,
      channel: { select: { name: true } },
      lineItems: {
        select: {
          skuId: true,
          approvedQty: true,
          requestedQty: true,
          channelSkuCode: true,
          rawData: true,
          sku: { select: { internalCode: true } },
        },
      },
    },
  });
  if (!po) return fail(new Error("PO not found"), 404);

  // Resolve the qty for each line from the pending allocation when supplied, so the
  // preview matches the email that will actually go out (custom qtys / removed SKUs).
  const allocMap = overrides.allocations
    ? new Map(overrides.allocations.map((a) => [a.skuId, a.approvedQty]))
    : null;
  const excluded = new Set(overrides.excludeSkuIds ?? []);
  const qtyForLine = (l: { skuId: string; approvedQty: number | null; requestedQty: number }) => {
    if (allocMap) return allocMap.get(l.skuId) ?? 0; // explicit: unknown SKU = not allocated
    if (excluded.has(l.skuId)) return 0;
    // A persisted 0 means the line was removed/zeroed; keep it 0 (dropped by the
    // qty>0 filter). Only fall back to requested when nothing was ever allocated.
    return l.approvedQty ?? l.requestedQty;
  };

  const eanMap = await mapEansToInternal(po.lineItems.map((l) => eanFromRaw(l.rawData))).catch(
    () => new Map<string, string>(),
  );
  const lines = po.lineItems
    .map((l) => ({
      sku: resolveLineInternalSku({
        source: po.source,
        channelCode: l.channelSkuCode ?? l.sku.internalCode,
        pvId: pvIdFromRaw(l.rawData),
        ean: eanFromRaw(l.rawData),
        eanMap,
      }),
      qty: qtyForLine(l),
    }))
    .filter((l) => l.qty > 0);

  const locFromPo = pickByPriority(po.rawData, LOCATION_PRIORITY);
  const location = locFromPo !== "—" ? locFromPo : pickByPriority(po.lineItems[0]?.rawData, LOCATION_PRIORITY);

  let dispatchFrom = "—";
  try {
    const r = await resolveDispatchFromForPo({ ...po, id: poId });
    if (r.dispatchFrom) dispatchFrom = r.dispatchFrom;
  } catch { /* preview is best-effort; finalised at send */ }

  let to: string[] = [];
  let cc: string[] = [];
  if (dispatchFrom !== "—") {
    const lr = await getLocationRecipients(dispatchFrom).catch(() => null);
    if (lr) {
      to = lr.to;
      cc = lr.cc;
    }
  }
  if (to.length === 0) {
    // Configured global recipients ONLY — never a personal/test inbox. Empty here means
    // the email would reach no one, which the UI flags for a recipient fix.
    const g = await getPoEmailRecipients();
    to = g.to;
    cc = g.cc;
  }

  const template = await getEmailTemplate();
  const html = buildHtml({
    poNumber: po.channelPoNumber ?? poId,
    channel: po.channel.name,
    location,
    dispatchFrom,
    lines,
    template,
  });

  const series = await getSeries();
  const redirect = await getEmailRedirect();

  // Subject defaults to the PO's reference: reuse the stored ref (already sent/held/
  // failed) so a resend keeps the same number, else peek the next series number.
  const refPreview = po.emailRef ?? `${series.prefix}${series.nextFormatted}`;
  const finalTo = redirect ? [redirect] : to;

  return ok({
    poNumber: po.channelPoNumber ?? poId,
    channel: po.channel.name,
    status: po.status,
    location,
    dispatchFrom,
    refPreview,
    emailRef: po.emailRef,
    emailStatus: po.emailStatus,
    emailHoldReason: po.emailHoldReason,
    to: finalTo,
    cc: redirect ? [] : cc,
    testMode: !!redirect,
    // True when this PO would reach nobody (no location/global recipients) — the UI
    // shows the "reached no one, add recipients & resend" banner. Test mode always has
    // the redirect recipient, so it's never "no one".
    willReachNoOne: !redirect && finalTo.length === 0,
    lineCount: lines.length,
    html,
  });
}

/** GET — preview from the PO's stored quantities (channel bulk-send modal). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return handler("GET /api/pos/[id]/email-preview", () => renderPreview(params.id, {}));
}

/**
 * POST — preview the email for a PENDING allocation the operator is reviewing.
 * Body: { allocations?: {skuId, approvedQty}[], excludeSkuIds?: string[] }.
 * Used by the allocation review/preview step so the preview matches the email that
 * will be sent (custom per-SKU quantities and SKUs removed during flag review).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("POST /api/pos/[id]/email-preview", async () => {
    const body = overrideSchema.parse(await req.json().catch(() => ({})));
    return renderPreview(params.id, body);
  });
}
