import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { sendPoPreparationEmail } from "@/lib/integrations/po-test-email";
import { getPoDocuments, extractGstinFromPdf } from "@/lib/services/po-documents";
import { resolveDispatchFromGstins } from "@/lib/services/po-documents-helpers";
import type { EmailAttachment } from "@/lib/integrations/po-test-email";

export const dynamic = "force-dynamic";

/** Send a real PO-preparation email for the most recent Blinkit PO that has a numeric partnersbiz id. */
export async function POST(_req: NextRequest) {
  return handler("POST /api/blinkit/test-email", async () => {
    await currentActor();

    const po = await prisma.purchaseOrder.findFirst({
      where: { source: "BLINKIT", channelPoNumber: { not: null } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        channelPoNumber: true,
        rawData: true,
        source: true,
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

    if (!po) {
      return ok({ sent: false, error: "No Blinkit PO found in database" });
    }

    // Fetch PDF + Excel once (failures are non-fatal)
    let docs: { pdf: { content: Buffer; filename: string } | null; excel: { content: Buffer; filename: string } | null; warnings: string[] } = { pdf: null, excel: null, warnings: [] };
    try {
      docs = await getPoDocuments(po);
    } catch (err) {
      docs.warnings.push(`Document fetch error: ${err instanceof Error ? err.message : err}`);
    }

    // Derive dispatch-from from the already-downloaded PDF (avoids a second download)
    const dispatchWarnings: string[] = [];
    let dispatchFrom = "—";
    if (docs.pdf) {
      try {
        const gstins = await extractGstinFromPdf(docs.pdf.content);
        const result = resolveDispatchFromGstins(gstins);
        dispatchFrom = result.dispatchFrom ?? "—";
        if (result.warning) dispatchWarnings.push(result.warning);
      } catch (err) {
        dispatchWarnings.push(`GSTIN extraction failed: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      dispatchWarnings.push("PDF unavailable — cannot resolve dispatch-from");
    }

    // Build attachments list
    const attachments: EmailAttachment[] = [];
    if (docs.pdf) {
      attachments.push({
        filename: docs.pdf.filename,
        content: docs.pdf.content,
        contentType: "application/pdf",
      });
    }
    if (docs.excel) {
      attachments.push({
        filename: docs.excel.filename,
        content: docs.excel.content,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    }

    // Build line items — prefer approvedQty, fall back to requestedQty
    const lines = po.lineItems
      .filter((l) => (l.approvedQty ?? l.requestedQty ?? 0) > 0)
      .map((l) => ({
        sku: l.channelSkuCode ?? l.sku.internalCode,
        qty: l.approvedQty ?? l.requestedQty ?? 0,
      }));

    // Extract location from PO rawData
    const rawData = po.rawData as Record<string, unknown> | null;
    const location = (rawData?.["facilityname"] ?? rawData?.["facility_name"] ?? rawData?.["warehouse"] ?? "—") as string;

    const result = await sendPoPreparationEmail({
      poNumber: po.channelPoNumber ?? po.id,
      channel: po.channel.name,
      location: String(location),
      dispatchFrom,
      lines,
      attachments,
    });

    return ok({
      sent: true,
      messageId: result.messageId,
      to: result.to,
      poId: po.id,
      poNumber: po.channelPoNumber,
      dispatchFrom,
      attachedFiles: attachments.map((a) => a.filename),
      warnings: [...docs.warnings, ...dispatchWarnings],
    });
  });
}
