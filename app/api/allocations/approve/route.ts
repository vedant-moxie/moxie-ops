import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";
import { sendEmail, warehouseInstructionEmail } from "@/lib/integrations/resend";
import { invalidateAtpCache } from "@/lib/integrations/wms-atp";
import { roundToCasePack, formatDate } from "@/lib/utils";
import { getPoDocuments, extractGstinFromPdf } from "@/lib/services/po-documents";
import { resolveDispatchFromGstins } from "@/lib/services/po-documents-helpers";

export const dynamic = "force-dynamic";

const schema = z.object({
  allocations: z.array(
    z.object({
      poId: z.string(),
      lines: z.array(
        z.object({ skuId: z.string(), approvedQty: z.number().int().nonnegative() }),
      ),
    }),
  ),
});

/**
 * Approve allocations for a batch of POs:
 *  1. persist approved quantities
 *  2. create a WarehouseInstruction per PO
 *  3. email the picking list to the warehouse via Resend
 *  4. mark each PO APPROVED + audit
 */
export async function POST(req: NextRequest) {
  return handler("POST /api/allocations/approve", async () => {
    const actor = await currentActor();
    const { allocations } = schema.parse(await req.json());

    const results: { poId: string; channelPoNumber: string | null; emailed: boolean }[] = [];

    for (const alloc of allocations) {
      // Write approved qtys + create the instruction transactionally
      const { po, instruction } = await prisma.$transaction(async (tx) => {
        for (const line of alloc.lines) {
          await tx.poLineItem.updateMany({
            where: { poId: alloc.poId, skuId: line.skuId },
            data: { approvedQty: line.approvedQty },
          });
        }
        const po = await tx.purchaseOrder.update({
          where: { id: alloc.poId },
          data: { status: "APPROVED", approvedBy: actor.label, approvedAt: new Date() },
          include: {
            channel: true,
            lineItems: { include: { sku: true } },
          },
        });
        const instruction = await tx.warehouseInstruction.upsert({
          where: { poId: alloc.poId },
          create: { poId: alloc.poId, sentToEmail: env.WAREHOUSE_EMAIL },
          update: {},
        });
        await writeAudit({
          tx,
          entityType: "PurchaseOrder",
          entityId: alloc.poId,
          action: "APPROVED",
          performedBy: actor.label,
          changes: { lines: alloc.lines },
        });
        return { po, instruction };
      });

      // Build + send the warehouse email (outside the txn)
      const lines = po.lineItems
        .filter((li) => (li.approvedQty ?? 0) > 0)
        .map((li) => ({
          internalCode: li.sku.internalCode,
          skuName: li.sku.name,
          qty: li.approvedQty ?? 0,
          casePacks: Math.ceil(
            roundToCasePack(li.approvedQty ?? 0, li.sku.casePackSize) / li.sku.casePackSize,
          ),
        }));

      // Fetch PDF + Excel once; derive dispatch-from from the PDF GSTIN (non-fatal on failure)
      let dispatchFrom: string | undefined;
      const attachments: { filename: string; content: Buffer }[] = [];
      try {
        const docs = await getPoDocuments(po);
        if (docs.pdf) {
          attachments.push({ filename: docs.pdf.filename, content: docs.pdf.content });
          try {
            const gstins = await extractGstinFromPdf(docs.pdf.content);
            const resolved = resolveDispatchFromGstins(gstins);
            if (resolved.dispatchFrom) dispatchFrom = resolved.dispatchFrom;
            if (resolved.warning) console.warn(`[approve] dispatchFrom for ${po.id}:`, resolved.warning);
          } catch (err) {
            console.warn(`[approve] GSTIN extraction failed for ${po.id}:`, err);
          }
        }
        if (docs.excel) attachments.push({ filename: docs.excel.filename, content: docs.excel.content });
        if (docs.warnings.length) {
          console.warn(`[approve] document fetch warnings for ${po.id}:`, docs.warnings);
        }
      } catch (err) {
        console.warn(`[approve] getPoDocuments failed for ${po.id}:`, err);
      }

      const tpl = warehouseInstructionEmail({
        channelName: po.channel.name,
        channelPoNumber: po.channelPoNumber ?? po.id,
        deliveryAddress: po.channel.billingAddress ?? "—",
        dispatchBy: formatDate(po.requestedDeliveryDate),
        dispatchFrom,
        warehouseInstructionId: instruction.id,
        lines,
      });

      let emailed = false;
      try {
        const messageId = await sendEmail({
          to: env.WAREHOUSE_EMAIL,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          attachments: attachments.length ? attachments : undefined,
        });
        await prisma.warehouseInstruction.update({
          where: { id: instruction.id },
          data: {
            sentAt: new Date(),
            resendMessageId: messageId,
            emailSubject: tpl.subject,
            emailBody: tpl.text,
          },
        });
        emailed = true;
      } catch (err) {
        console.error(`[approve] warehouse email failed for ${po.id}`, err);
      }

      results.push({ poId: po.id, channelPoNumber: po.channelPoNumber, emailed });
    }

    invalidateAtpCache();
    return ok({ approved: results.length, results });
  });
}
