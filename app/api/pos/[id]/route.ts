import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return handler("GET /api/pos/[id]", async () => {
    await currentActor();
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: params.id },
      include: {
        channel: true,
        lineItems: { include: { sku: true } },
        warehouseInstruction: true,
        dispatchRecord: { include: { lineItems: { include: { sku: true } } } },
        deliveryRecord: true,
        grnRecord: { include: { lineItems: { include: { sku: true } }, discrepancies: true } },
        invoice: true,
      },
    });
    if (!po) return fail(new Error("PO not found"), 404);
    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: "PurchaseOrder", entityId: params.id },
      orderBy: { createdAt: "asc" },
    });
    return ok({ ...po, auditLogs });
  });
}

const patchSchema = z.object({
  status: z
    .enum([
      "PENDING_REVIEW", "PRIORITISED", "ALLOCATED", "APPROVED", "DISPATCHED",
      "DELIVERED", "GRN_RECEIVED", "CLOSED", "DISCREPANCY", "ON_HOLD",
    ])
    .optional(),
  priority: z.enum(["P1", "P2", "P3"]).nullable().optional(),
  opsNotes: z.string().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("PATCH /api/pos/[id]", async () => {
    const actor = await currentActor();
    const body = patchSchema.parse(await req.json());

    const before = await prisma.purchaseOrder.findUnique({
      where: { id: params.id },
      select: { status: true, priority: true },
    });
    if (!before) return fail(new Error("PO not found"), 404);

    const updated = await prisma.purchaseOrder.update({
      where: { id: params.id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.opsNotes !== undefined ? { opsNotes: body.opsNotes } : {}),
      },
    });

    await writeAudit({
      entityType: "PurchaseOrder",
      entityId: params.id,
      action: body.priority !== undefined ? "PRIORITY_CHANGED" : "STATUS_CHANGED",
      performedBy: actor.label,
      changes: { before, after: { status: updated.status, priority: updated.priority } },
    });

    return ok(updated);
  });
}
