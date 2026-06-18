import "server-only";
import { prisma } from "@/lib/db";
import { readLiveAtp } from "@/lib/integrations/wms-atp";
import { resolveInternalSkuAnyChannel } from "@/lib/services/sku-resolver";

const DAY = 86_400_000;

/** One row of the dashboard "Live ATP" sidebar — deduped to the master SKU. */
export interface LiveAtpRow {
  /** Master Moxie internal code (e.g. "WLIC50") — the dedupe key. */
  code: string;
  name: string;
  /** Free saleable stock for the master SKU. */
  atpQty: number;
  onHandQty: number;
  reservedQty: number;
  /** Units ordered today across every channel variant of this SKU. */
  demand: number;
}

/**
 * Demand per master SKU for "today" — a PO counts as today when its poDate (or
 * createdAt when poDate is missing) falls on the current local day. Only open
 * POs (still to be received) contribute. Channel SKU codes are resolved to their
 * master code so variants of the same product roll up into one number.
 */
async function todaysDemandByMaster(): Promise<Map<string, number>> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY);

  const lines = await prisma.poLineItem.findMany({
    where: {
      po: {
        status: { in: ["PENDING_REVIEW", "PRIORITISED", "ALLOCATED"] },
        OR: [
          { poDate: { gte: start, lt: end } },
          { poDate: null, createdAt: { gte: start, lt: end } },
        ],
      },
    },
    select: { requestedQty: true, sku: { select: { internalCode: true } } },
  });

  const demand = new Map<string, number>();
  for (const l of lines) {
    const code = resolveInternalSkuAnyChannel(l.sku.internalCode);
    demand.set(code, (demand.get(code) ?? 0) + l.requestedQty);
  }
  return demand;
}

/**
 * Live ATP rows for the dashboard sidebar: ATP deduped to the master SKU, joined
 * to today's ordered quantity, ranked by demand, limited to SKUs actually ordered
 * today. Returns an empty list when there are no POs today.
 */
export async function getLiveAtp(opts: { force?: boolean } = {}): Promise<LiveAtpRow[]> {
  const [variants, demand] = await Promise.all([
    readLiveAtp({ force: opts.force }),
    todaysDemandByMaster(),
  ]);

  // Collapse channel variants into one row per master. ATP is the same physical
  // free stock for every variant, so take the representative value (max guards
  // against a variant row that resolved to 0), never the sum.
  const byMaster = new Map<string, LiveAtpRow>();
  for (const v of variants) {
    const code = resolveInternalSkuAnyChannel(v.internalCode);
    const cur = byMaster.get(code);
    if (!cur) {
      byMaster.set(code, {
        code,
        name: v.name,
        atpQty: v.atpQty,
        onHandQty: v.onHandQty,
        reservedQty: v.reservedQty,
        demand: demand.get(code) ?? 0,
      });
    } else {
      cur.atpQty = Math.max(cur.atpQty, v.atpQty);
      cur.onHandQty = Math.max(cur.onHandQty, v.onHandQty);
      cur.reservedQty = Math.max(cur.reservedQty, v.reservedQty);
      if (!cur.name && v.name) cur.name = v.name;
    }
  }

  // A SKU may be ordered today but have no ATP row (e.g. brand-new SKU); surface
  // it anyway so demand without stock is visible.
  for (const [code, qty] of demand) {
    if (!byMaster.has(code)) {
      byMaster.set(code, { code, name: "", atpQty: 0, onHandQty: 0, reservedQty: 0, demand: qty });
    }
  }

  return [...byMaster.values()]
    .filter((r) => r.demand > 0)
    .sort((a, b) => b.demand - a.demand)
    .slice(0, 10);
}
