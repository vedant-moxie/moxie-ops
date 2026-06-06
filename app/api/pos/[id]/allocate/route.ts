import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";
import { sendPoPreparationEmail } from "@/lib/integrations/po-test-email";
import type { EmailAttachment } from "@/lib/integrations/po-test-email";
import { getPoDocuments, extractGstinFromPdf } from "@/lib/services/po-documents";
import { resolveDispatchFromGstins } from "@/lib/services/po-documents-helpers";

export const dynamic = "force-dynamic";

const schema = z.object({
  allocations: z.array(
    z.object({ skuId: z.string(), approvedQty: z.number().int().nonnegative() }),
  ),
});

const FACILITY_KEYS = ["facilityname", "facility_name", "facility", "warehouse", "outlet", "store", "dcname", "dc", "destination"];
const DISPATCH_KEYS = ["dispatchfrom", "dispatch_from", "sourcewh", "source_wh", "sourcecode", "fromwh", "fromwarehouse", "senderfacility"];

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

/** Fall back to the PO line item's original ordered qty when approvedQty is absent. */
function orderedQty(rawData: unknown): number {
  if (!rawData || typeof rawData !== "object") return 0;
  const raw = rawData as Record<string, unknown>;
  for (const key of ["units_ordered", "ordered_qty", "quantity", "order_qty"]) {
    const v = raw[key];
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 0;
}

/** Persist per-SKU approved quantities for one PO and email abhishek@ about preparation. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("POST /api/pos/[id]/allocate", async () => {
    const actor = await currentActor();
    const { allocations } = schema.parse(await req.json());

    await prisma.$transaction(async (tx) => {
      for (const a of allocations) {
        await tx.poLineItem.updateMany({
          where: { poId: params.id, skuId: a.skuId },
          data: { approvedQty: a.approvedQty },
        });
      }
      await tx.purchaseOrder.update({
        where: { id: params.id },
        data: { status: "ALLOCATED" },
      });
      await writeAudit({
        tx,
        entityType: "PurchaseOrder",
        entityId: params.id,
        action: "ALLOCATED",
        performedBy: actor.label,
        changes: { allocations },
      });
    });

    // Build and send the PO-preparation email with the real PO data.
    let emailMessageId: string | null = null;
    try {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: params.id },
        select: {
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

      if (po) {
        // Build allocation map from the just-saved values
        const allocMap = Object.fromEntries(allocations.map((a) => [a.skuId, a.approvedQty]));

        // Extract location from PO rawData, fall back to first line item rawData
        const firstLineRaw = po.lineItems[0]?.rawData;
        const location =
          extractRaw(po.rawData, FACILITY_KEYS) !== "—"
            ? extractRaw(po.rawData, FACILITY_KEYS)
            : extractRaw(firstLineRaw, FACILITY_KEYS);

        // Fetch PDF + Excel once; derive dispatch-from from the PDF (avoids double download)
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
            // Resolve dispatch-from from the PDF GSTIN; overrides rawData if successful
            try {
              const gstins = await extractGstinFromPdf(docs.pdf.content);
              const resolved = resolveDispatchFromGstins(gstins);
              if (resolved.dispatchFrom) dispatchFrom = resolved.dispatchFrom;
              if (resolved.warning) console.warn("[allocate] dispatchFrom:", resolved.warning);
            } catch (err) {
              console.warn("[allocate] GSTIN extraction failed:", err);
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
            console.warn("[allocate] document fetch warnings:", docs.warnings);
          }
        } catch (err) {
          console.warn("[allocate] getPoDocuments failed:", err);
        }

        const result = await sendPoPreparationEmail({
          poNumber: po.channelPoNumber ?? params.id,
          channel: po.channel.name,
          location,
          dispatchFrom,
          lines: po.lineItems
            .map((l) => {
              // allocMap wins; fall back to saved approvedQty; finally fall back to
              // requestedQty (always populated DB column) so lines are never blank
              const qty: number =
                allocMap[l.skuId] != null
                  ? (allocMap[l.skuId] as number)
                  : (l.approvedQty ?? 0) > 0
                    ? l.approvedQty!
                    : l.requestedQty;
              return { sku: l.channelSkuCode ?? l.sku.internalCode, qty };
            })
            .filter((l) => l.qty > 0),
          attachments,
        });
        emailMessageId = result.messageId;
      }
    } catch (err) {
      // Email failure is non-fatal — allocation is already saved.
      console.error("[allocate] email send failed:", err);
    }

    return ok({ poId: params.id, lines: allocations.length, emailMessageId });
  });
}
