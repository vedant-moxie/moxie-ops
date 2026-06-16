import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Allocation-safe sync.
 *
 * Channel syncs upsert POs and (for existing ones) delete+recreate line items,
 * GRNs and discrepancies. That's fine while a PO is still in the review queue,
 * but once it's been allocated (or anything later) those child rows hold real
 * work — `approvedQty`, the dispatch email's reference, GRN receipts — that must
 * NOT be wiped just because the channel re-reported the PO.
 *
 * So allocation is a **one-way latch**: a PO whose status has left the review
 * queue is "locked". For locked POs, sync only refreshes the raw channel
 * snapshot (`rawData`) and leaves status + line items + GRNs + discrepancies
 * untouched. New POs and still-in-review POs refresh fully, as before.
 */

// The only statuses a sync may fully refresh. Everything else is post-allocation
// (ALLOCATED / APPROVED / DISPATCHED / DELIVERED / GRN_RECEIVED / CLOSED /
// DISCREPANCY / ON_HOLD) and is preserved. New statuses default to "locked".
const REFRESHABLE_STATUSES = new Set<string>(["PENDING_REVIEW", "PRIORITISED"]);

export function isAllocationLocked(status: string | null | undefined): boolean {
  return !!status && !REFRESHABLE_STATUSES.has(status);
}

/**
 * Within a transaction, report whether the PO (by externalId) already exists and
 * is allocation-locked. Returns null when the PO is new (→ create + full refresh).
 */
export async function poLockState(
  tx: Prisma.TransactionClient,
  externalId: string,
): Promise<{ id: string; locked: boolean } | null> {
  const existing = await tx.purchaseOrder.findUnique({
    where: { externalId },
    select: { id: true, status: true },
  });
  if (!existing) return null;
  return { id: existing.id, locked: isAllocationLocked(existing.status) };
}
