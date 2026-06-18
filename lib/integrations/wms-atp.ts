import { prisma } from "@/lib/db";
import { resolveInternalSkuAnyChannel } from "@/lib/services/sku-resolver";

export interface AtpRow {
  skuId: string;
  internalCode: string;
  name: string;
  onHandQty: number;
  reservedQty: number;
  safetyStock: number;
  atpQty: number;
  casePackSize: number;
}

// 30-second in-memory cache to avoid hammering the DB on each keystroke.
let cache: { at: number; data: AtpRow[] } | null = null;
const CACHE_MS = 30_000;

/**
 * Live ATP from the WMS `WarehouseStock` mirror — the only source of truth for
 * available stock. ATP = free saleable stock summed across warehouses per master
 * SKU. Channel-specific SKU codes resolve to their master code first (e.g. a
 * Blinkit item id → "WLIC50"). When the mirror is empty, every SKU reports 0.
 */
export async function readLiveAtp(opts: { force?: boolean } = {}): Promise<AtpRow[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const [skus, stockRows] = await Promise.all([
    prisma.sku.findMany({
      where: { active: true },
      select: { id: true, internalCode: true, name: true, casePackSize: true },
    }),
    prisma.warehouseStock.findMany({
      select: { skuCode: true, freeQty: true, totalQty: true, lockedQty: true },
    }),
  ]);

  // master code → stock aggregated across all warehouses
  const byMaster = new Map<string, { free: number; total: number; locked: number }>();
  for (const r of stockRows) {
    const cur = byMaster.get(r.skuCode) ?? { free: 0, total: 0, locked: 0 };
    cur.free += r.freeQty;
    cur.total += r.totalQty;
    cur.locked += r.lockedQty;
    byMaster.set(r.skuCode, cur);
  }

  const data: AtpRow[] = skus.map((sku) => {
    const master = resolveInternalSkuAnyChannel(sku.internalCode);
    const agg = byMaster.get(master) ?? { free: 0, total: 0, locked: 0 };
    return {
      skuId: sku.id,
      internalCode: sku.internalCode,
      name: sku.name,
      onHandQty: agg.total,
      reservedQty: agg.locked,
      safetyStock: 0,
      atpQty: agg.free,
      casePackSize: sku.casePackSize,
    };
  });

  cache = { at: Date.now(), data };
  return data;
}

export function invalidateAtpCache() {
  cache = null;
}
