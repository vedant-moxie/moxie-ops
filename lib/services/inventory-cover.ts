import "server-only";
import { prisma } from "@/lib/db";
import { fetchWmsOutwardReport, wmsConfigured } from "@/lib/integrations/wms";
import { resolveInternalSkuAnyChannel } from "@/lib/services/sku-resolver";
import { skuMasterMaps } from "@/lib/sku-master-runtime";

const DAY_MS = 86_400_000;

export type CoverStage = "CRITICAL" | "RESTOCK" | "UNDER_CHECK" | "OVERSTOCKED" | "NO_DATA";

export interface InventoryCoverRow {
  skuCode: string;
  skuName: string;
  soh: number;
  outward7d: number;
  outward30d: number;
  drr7d: number;
  drr30d: number;
  /** Days of stock remaining. null when DRR = 0. */
  cover: number | null;
  stage: CoverStage;
}

function toStage(cover: number | null): CoverStage {
  if (cover === null) return "NO_DATA";
  if (cover < 20) return "CRITICAL";
  if (cover < 60) return "RESTOCK";
  if (cover < 90) return "UNDER_CHECK";
  return "OVERSTOCKED";
}

// In-memory cache for the outward report (refreshed at most once per 15 min)
let outwardCache: { rows: { skuCode: string; date: Date; qty: number }[]; fetchedAt: number } | null = null;
const OUTWARD_CACHE_MS = 15 * 60_000;

async function getOutwardRows(since30d: Date): Promise<{ skuCode: string; date: Date; qty: number }[]> {
  if (outwardCache && Date.now() - outwardCache.fetchedAt < OUTWARD_CACHE_MS) {
    return outwardCache.rows.filter((r) => r.date >= since30d);
  }
  const raw = await fetchWmsOutwardReport(since30d);
  const rows = raw.map((r) => ({ skuCode: r.skuCode, date: r.outwardDate, qty: r.dispatchedQty }));
  outwardCache = { rows, fetchedAt: Date.now() };
  return rows;
}

/**
 * Computes SOH / DRR / Cover for every master SKU.
 *
 * SOH: sum of freeQty across all warehouses from the WMS mirror (WarehouseStock).
 * Outward: from the WMS "Outward LOI Report", filtered by Outward Date.
 *   Falls back to DispatchLineItem dispatch records if WMS is not configured or
 *   the report fetch fails.
 */
export async function computeInventoryCover(): Promise<InventoryCoverRow[]> {
  const now = Date.now();
  const since30d = new Date(now - 30 * DAY_MS);
  const cutoff7d = new Date(now - 7 * DAY_MS);
  const MASTER_SKUS = skuMasterMaps().masterSkus;

  // ── SOH: sum freeQty across all warehouses per SKU code ──────────────────
  const stockRows = await prisma.warehouseStock.findMany({
    select: { skuCode: true, freeQty: true },
  });
  const sohByCode = new Map<string, number>();
  for (const row of stockRows) {
    sohByCode.set(row.skuCode, (sohByCode.get(row.skuCode) ?? 0) + row.freeQty);
  }

  // ── Outward: WMS Outward LOI Report (Outward Date) ───────────────────────
  const out7d = new Map<string, number>();
  const out30d = new Map<string, number>();

  let usedWmsOutward = false;
  if (wmsConfigured()) {
    try {
      const outwardRows = await getOutwardRows(since30d);
      for (const row of outwardRows) {
        // WMS outward codes are master codes — same namespace as WarehouseStock.skuCode
        out30d.set(row.skuCode, (out30d.get(row.skuCode) ?? 0) + row.qty);
        if (row.date >= cutoff7d) {
          out7d.set(row.skuCode, (out7d.get(row.skuCode) ?? 0) + row.qty);
        }
      }
      usedWmsOutward = true;
    } catch (err) {
      console.warn("[inventory-cover] WMS outward report failed, falling back to dispatch records:", err);
    }
  }

  if (!usedWmsOutward) {
    // Fallback: use our own dispatch records keyed by master SKU code
    const dispatchItems = await prisma.dispatchLineItem.findMany({
      where: { dispatchRecord: { dispatchedAt: { gte: since30d } } },
      select: {
        skuId: true,
        dispatchedQty: true,
        dispatchRecord: { select: { dispatchedAt: true } },
      },
    });
    const skuIds = [...new Set(dispatchItems.map((i) => i.skuId))];
    const skus = await prisma.sku.findMany({
      where: { id: { in: skuIds } },
      select: { id: true, internalCode: true },
    });
    const masterById = new Map(
      skus.map((s) => [s.id, resolveInternalSkuAnyChannel(s.internalCode)]),
    );
    for (const item of dispatchItems) {
      const code = masterById.get(item.skuId);
      if (!code) continue;
      out30d.set(code, (out30d.get(code) ?? 0) + item.dispatchedQty);
      if (item.dispatchRecord.dispatchedAt && item.dispatchRecord.dispatchedAt >= cutoff7d) {
        out7d.set(code, (out7d.get(code) ?? 0) + item.dispatchedQty);
      }
    }
  }

  // ── Build rows for every master SKU ──────────────────────────────────────
  const dbSkus = await prisma.sku.findMany({
    where: { internalCode: { in: [...MASTER_SKUS] } },
    select: { internalCode: true, name: true },
  });
  const nameByCode = new Map<string, string>(dbSkus.map((s) => [s.internalCode, s.name]));

  // SkuMaster names fill gaps (some codes may only be in the master table)
  const masterNames = await prisma.skuMaster.findMany({
    where: { internalCode: { in: [...MASTER_SKUS] } },
    select: { internalCode: true, name: true },
  });
  for (const m of masterNames) {
    if (m.name && !nameByCode.has(m.internalCode)) nameByCode.set(m.internalCode, m.name);
  }

  const rows: InventoryCoverRow[] = [];
  for (const code of MASTER_SKUS) {
    const soh = sohByCode.get(code) ?? 0;
    const o7 = out7d.get(code) ?? 0;
    const o30 = out30d.get(code) ?? 0;
    const drr7 = Math.round((o7 / 7) * 10) / 10;
    const drr30 = Math.round((o30 / 30) * 10) / 10;
    const maxDrr = Math.max(drr7, drr30);
    const cover = maxDrr > 0 ? Math.round(soh / maxDrr) : null;
    rows.push({
      skuCode: code,
      skuName: nameByCode.get(code) ?? code,
      soh,
      outward7d: o7,
      outward30d: o30,
      drr7d: drr7,
      drr30d: drr30,
      cover,
      stage: toStage(cover),
    });
  }

  const stageOrder: Record<CoverStage, number> = {
    CRITICAL: 0, RESTOCK: 1, UNDER_CHECK: 2, OVERSTOCKED: 3, NO_DATA: 4,
  };
  rows.sort((a, b) => {
    const sd = stageOrder[a.stage] - stageOrder[b.stage];
    if (sd !== 0) return sd;
    return (a.cover ?? 9999) - (b.cover ?? 9999);
  });

  return rows;
}
