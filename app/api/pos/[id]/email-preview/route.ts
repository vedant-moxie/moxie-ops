import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildHtml } from "@/lib/integrations/po-test-email";
import { LOCATION_PRIORITY, pickByPriority } from "@/lib/services/allocate-and-email";
import { resolveLineInternalSku, eanFromRaw } from "@/lib/services/sku-resolver";
import { mapEansToInternal } from "@/lib/services/sku-ean-resolver";
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
 * GET /api/pos/[id]/email-preview
 *
 * Renders the dispatch email for a PO exactly as it would be sent (greeting/intro/
 * SKU table/PO bullets/signature from the editable template, internal SKU codes,
 * resolved Location/WH + Dispatch-From + recipients) — WITHOUT sending and without
 * consuming a reference number. Used by the channel bulk-send "review" modal.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return handler("GET /api/pos/[id]/email-preview", async () => {
    await requireAuth();
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: params.id },
      select: {
        channelPoNumber: true,
        source: true,
        rawData: true,
        status: true,
        channel: { select: { name: true } },
        lineItems: {
          select: {
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

    const eanMap = await mapEansToInternal(po.lineItems.map((l) => eanFromRaw(l.rawData))).catch(
      () => new Map<string, string>(),
    );
    const lines = po.lineItems
      .map((l) => ({
        sku: resolveLineInternalSku({
          source: po.source,
          channelCode: l.channelSkuCode ?? l.sku.internalCode,
          ean: eanFromRaw(l.rawData),
          eanMap,
        }),
        qty: (l.approvedQty ?? 0) > 0 ? l.approvedQty! : l.requestedQty,
      }))
      .filter((l) => l.qty > 0);

    const locFromPo = pickByPriority(po.rawData, LOCATION_PRIORITY);
    const location = locFromPo !== "—" ? locFromPo : pickByPriority(po.lineItems[0]?.rawData, LOCATION_PRIORITY);

    let dispatchFrom = "—";
    try {
      const r = await resolveDispatchFromForPo(po);
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
      const g = await getPoEmailRecipients();
      to = g.to;
      cc = g.cc;
    }

    const template = await getEmailTemplate();
    const html = buildHtml({
      poNumber: po.channelPoNumber ?? params.id,
      channel: po.channel.name,
      location,
      dispatchFrom,
      lines,
      template,
    });

    const series = await getSeries();
    const redirect = await getEmailRedirect();

    return ok({
      poNumber: po.channelPoNumber ?? params.id,
      channel: po.channel.name,
      status: po.status,
      location,
      dispatchFrom,
      subjectPreview: `${series.prefix}${series.nextFormatted}`,
      to: redirect ? [redirect] : to,
      cc: redirect ? [] : cc,
      testMode: !!redirect,
      lineCount: lines.length,
      html,
    });
  });
}
