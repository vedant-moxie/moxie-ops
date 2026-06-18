import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { readLiveAtp } from "@/lib/integrations/wms-atp";
import { suggestAllocations } from "@/lib/integrations/claude";
import { roundToCasePack } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 };

/**
 * Suggest allocation quantities across the POs awaiting allocation.
 * Uses Claude when configured; otherwise falls back to a deterministic
 * priority-greedy allocator so the grid always pre-fills.
 */
export async function POST(_req: NextRequest) {
  return handler("POST /api/allocations/suggest", async () => {
    await requireAuth();

    const pos = await prisma.purchaseOrder.findMany({
      where: { status: { in: ["PENDING_REVIEW", "PRIORITISED", "ALLOCATED"] } },
      include: { channel: true, lineItems: true },
      orderBy: [{ priorityScore: "desc" }],
    });
    const atp = await readLiveAtp();
    const atpById = new Map(atp.map((a) => [a.skuId, a]));

    // Try Claude first
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const suggestion = await suggestAllocations({
          atp: atp.map((a) => ({
            sku_id: a.skuId,
            internal_code: a.internalCode,
            atp_qty: a.atpQty,
            case_pack_size: a.casePackSize,
          })),
          pos: pos.map((p) => ({
            po_id: p.id,
            channel: p.channel.name,
            priority: p.priority,
            lines: p.lineItems.map((l) => ({ sku_id: l.skuId, requested_qty: l.requestedQty })),
          })),
        });
        return ok({ source: "ai", allocations: suggestion.allocations });
      } catch (err) {
        console.error("[suggest] Claude failed, using greedy fallback", err);
      }
    }

    // Deterministic priority-greedy fallback
    const remaining = new Map(atp.map((a) => [a.skuId, a.atpQty]));
    const sorted = [...pos].sort(
      (a, b) =>
        (PRIORITY_RANK[a.priority ?? "P3"] ?? 2) - (PRIORITY_RANK[b.priority ?? "P3"] ?? 2) ||
        (b.priorityScore ?? 0) - (a.priorityScore ?? 0),
    );
    const allocations: { po_id: string; sku_id: string; suggested_qty: number }[] = [];
    for (const po of sorted) {
      for (const line of po.lineItems) {
        const avail = remaining.get(line.skuId) ?? 0;
        const pack = atpById.get(line.skuId)?.casePackSize ?? 1;
        let qty = Math.min(line.requestedQty, Math.max(0, avail));
        qty = Math.min(roundToCasePack(qty, pack), line.requestedQty, Math.max(0, avail));
        remaining.set(line.skuId, avail - qty);
        allocations.push({ po_id: po.id, sku_id: line.skuId, suggested_qty: qty });
      }
    }
    return ok({ source: "greedy", allocations });
  });
}
