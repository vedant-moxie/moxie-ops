import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/** How long a claim is held without activity before it's considered abandoned. */
export const CLAIM_TTL_MS = 20 * 60_000; // 20 minutes

export interface Actor {
  id: string;
  label: string;
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Error thrown when a PO is actively claimed by a different user. */
export class PoClaimedError extends Error {
  constructor(public claimedByLabel: string | null) {
    super(`This PO is being allocated by ${claimedByLabel ?? "another user"}.`);
    this.name = "PoClaimedError";
  }
}

function staleThreshold(): Date {
  return new Date(Date.now() - CLAIM_TTL_MS);
}

/**
 * Atomically claim a PO for `actor`. The conditional updateMany succeeds (count===1)
 * only when the PO is unclaimed, already held by this actor, or the previous claim
 * has gone stale — all evaluated inside a single SQL UPDATE, so two users racing to
 * open/allocate the same PO can never both win. Returns who holds it on failure.
 */
export async function claimPo(
  poId: string,
  actor: Actor,
  db: Db = prisma,
): Promise<{ ok: boolean; claimedByLabel: string | null }> {
  const res = await db.purchaseOrder.updateMany({
    where: {
      id: poId,
      OR: [
        { claimedById: null },
        { claimedById: actor.id },
        { claimedAt: { lt: staleThreshold() } },
      ],
    },
    data: { claimedById: actor.id, claimedByLabel: actor.label, claimedAt: new Date() },
  });
  if (res.count === 1) return { ok: true, claimedByLabel: actor.label };
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    select: { claimedByLabel: true },
  });
  return { ok: false, claimedByLabel: po?.claimedByLabel ?? null };
}

/** Release a claim — only if `actorId` currently holds it (never steals another's). */
export async function releasePo(poId: string, actorId: string, db: Db = prisma): Promise<void> {
  await db.purchaseOrder.updateMany({
    where: { id: poId, claimedById: actorId },
    data: { claimedById: null, claimedByLabel: null, claimedAt: null },
  });
}

/** True when the PO is actively claimed (non-stale) by someone OTHER than actorId. */
export function isClaimedByOther(
  po: { claimedById: string | null; claimedAt: Date | string | null },
  actorId: string,
): boolean {
  if (!po.claimedById || po.claimedById === actorId || !po.claimedAt) return false;
  const at = typeof po.claimedAt === "string" ? new Date(po.claimedAt) : po.claimedAt;
  return at.getTime() >= Date.now() - CLAIM_TTL_MS;
}
