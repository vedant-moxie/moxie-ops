import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { fetchWmsStock, wmsConfigured } from "@/lib/integrations/wms";
import { warehouseByWmsName, warehouseByCode } from "@/lib/warehouses";
import { resolveInternalSkuAnyChannel } from "@/lib/services/sku-resolver";

export interface WarehouseStockEntry {
  warehouseCode: string;
  warehouseName: string;
  /** Free available saleable units (WMS free minus local allocations since sync) */
  freeQty: number;
  /** Total saleable on hand in WMS */
  totalQty: number;
  syncedAt: string;
}

/** skuId → per-warehouse entries */
export type WarehouseStockBySku = Record<string, WarehouseStockEntry[]>;

export interface WmsSyncResult {
  ok: boolean;
  rows: number;
  warehouses: string[];
  skippedWarehouses: string[];
  error?: string;
}

// One sync at a time per server instance; concurrent readers await the same promise.
let inflightSync: Promise<WmsSyncResult> | null = null;

/**
 * Pulls the WMS Consolidated Stock report and mirrors *saleable* rows into
 * WarehouseStock. Re-baselines freeQty to the WMS free-available figure —
 * by the next sync the WMS itself reflects allocations as salesorder-locked
 * stock, so local decrements are intentionally overwritten.
 */
export async function syncWmsStock(): Promise<WmsSyncResult> {
  if (inflightSync) return inflightSync;
  inflightSync = doSync().finally(() => {
    inflightSync = null;
  });
  return inflightSync;
}

async function doSync(): Promise<WmsSyncResult> {
  if (!wmsConfigured()) {
    return { ok: false, rows: 0, warehouses: [], skippedWarehouses: [], error: "WMS_EMAIL / WMS_PASSWORD not set" };
  }
  const all = await fetchWmsStock();
  const saleable = all.filter((r) => r.stockType.toLowerCase() === "saleable");

  const syncedAt = new Date();
  const seen = new Set<string>();
  const skipped = new Set<string>();
  let count = 0;

  for (const row of saleable) {
    const wh = warehouseByWmsName(row.warehouseName);
    if (!wh) {
      skipped.add(row.warehouseName);
      continue;
    }
    seen.add(wh.code);
    await prisma.warehouseStock.upsert({
      where: { warehouseCode_skuCode: { warehouseCode: wh.code, skuCode: row.skuCode } },
      create: {
        warehouseCode: wh.code,
        skuCode: row.skuCode,
        totalQty: row.quantity,
        lockedQty: row.lockedQty,
        wmsFreeQty: row.freeQty,
        freeQty: row.freeQty,
        syncedAt,
      },
      update: {
        totalQty: row.quantity,
        lockedQty: row.lockedQty,
        wmsFreeQty: row.freeQty,
        freeQty: row.freeQty,
        syncedAt,
      },
    });
    count++;
  }

  // SKUs that disappeared from the report no longer have saleable stock.
  await prisma.warehouseStock.updateMany({
    where: { syncedAt: { lt: syncedAt } },
    data: { totalQty: 0, lockedQty: 0, wmsFreeQty: 0, freeQty: 0, syncedAt },
  });

  if (skipped.size > 0) {
    console.warn("[wms-stock] unmapped WMS warehouses skipped:", [...skipped]);
  }
  console.info(`[wms-stock] synced ${count} saleable rows across ${seen.size} warehouses`);
  return { ok: true, rows: count, warehouses: [...seen], skippedWarehouses: [...skipped] };
}

/** True when the mirror is empty or older than WMS_STOCK_STALE_MINUTES. */
export async function isWmsStockStale(): Promise<boolean> {
  const newest = await prisma.warehouseStock.findFirst({
    orderBy: { syncedAt: "desc" },
    select: { syncedAt: true },
  });
  if (!newest) return true;
  return Date.now() - newest.syncedAt.getTime() > env.WMS_STOCK_STALE_MINUTES * 60_000;
}

/**
 * Per-warehouse free stock for the given SKU ids (DB Sku.id values).
 * Channel-specific internal codes (e.g. Blinkit item ids) are resolved to
 * master codes before matching WMS rows. Syncs first when the mirror is stale.
 */
export async function readWarehouseStock(skuIds: string[]): Promise<WarehouseStockBySku> {
  const result: WarehouseStockBySku = {};
  for (const id of skuIds) result[id] = [];
  if (skuIds.length === 0 || !wmsConfigured()) return result;

  if (await isWmsStockStale()) {
    try {
      await syncWmsStock();
    } catch (err) {
      console.warn("[wms-stock] stale sync failed, serving cached rows:", err);
    }
  }

  const skus = await prisma.sku.findMany({
    where: { id: { in: skuIds } },
    select: { id: true, internalCode: true },
  });
  // master code → sku ids (multiple channel rows can resolve to one master code)
  const idsByMaster = new Map<string, string[]>();
  for (const s of skus) {
    const master = resolveInternalSkuAnyChannel(s.internalCode);
    idsByMaster.set(master, [...(idsByMaster.get(master) ?? []), s.id]);
  }

  const stockRows = await prisma.warehouseStock.findMany({
    where: { skuCode: { in: [...idsByMaster.keys()] } },
  });
  for (const row of stockRows) {
    const wh = warehouseByCode(row.warehouseCode);
    for (const skuId of idsByMaster.get(row.skuCode) ?? []) {
      result[skuId]!.push({
        warehouseCode: row.warehouseCode,
        warehouseName: wh?.wmsName ?? row.warehouseCode,
        freeQty: row.freeQty,
        totalQty: row.totalQty,
        syncedAt: row.syncedAt.toISOString(),
      });
    }
  }

  // For SKUs that still have no stock entries, check confirmed AI mappings.
  // These are Blinkit item IDs not in BLINKIT_TO_INTERNAL that were resolved by the AI mapper.
  const unmappedIds = skuIds.filter((id) => result[id]!.length === 0);
  if (unmappedIds.length > 0) {
    const confirmedMappings = await prisma.skuItemMapping.findMany({
      where: { skuId: { in: unmappedIds }, confirmedAt: { not: null } },
      select: { skuId: true, wmsCode: true },
    });
    if (confirmedMappings.length > 0) {
      const mappedCodes = confirmedMappings.map((m) => m.wmsCode);
      const mappedStockRows = await prisma.warehouseStock.findMany({
        where: { skuCode: { in: mappedCodes } },
      });
      const stockByWmsCode = new Map<string, typeof mappedStockRows>();
      for (const row of mappedStockRows) {
        const arr = stockByWmsCode.get(row.skuCode) ?? [];
        arr.push(row);
        stockByWmsCode.set(row.skuCode, arr);
      }
      for (const mapping of confirmedMappings) {
        for (const row of stockByWmsCode.get(mapping.wmsCode) ?? []) {
          const wh = warehouseByCode(row.warehouseCode);
          result[mapping.skuId]!.push({
            warehouseCode: row.warehouseCode,
            warehouseName: wh?.wmsName ?? row.warehouseCode,
            freeQty: row.freeQty,
            totalQty: row.totalQty,
            syncedAt: row.syncedAt.toISOString(),
          });
        }
      }
    }
  }

  for (const id of skuIds) {
    result[id]!.sort((a, b) => a.warehouseCode.localeCompare(b.warehouseCode));
  }
  return result;
}

/**
 * Subtracts allocated quantities from a warehouse's free stock so the next PO
 * sees reduced availability immediately (the WMS only reflects the lock once
 * its salesorder lands). Atomic, clamped at zero.
 */
export async function decrementWarehouseStock(
  warehouseCode: string,
  lines: Array<{ skuCode: string; qty: number }>,
): Promise<void> {
  for (const line of lines) {
    if (line.qty <= 0) continue;
    const master = resolveInternalSkuAnyChannel(line.skuCode);
    await prisma.$executeRaw`
      UPDATE "WarehouseStock"
      SET "freeQty" = GREATEST(0, "freeQty" - ${line.qty}), "updatedAt" = NOW()
      WHERE "warehouseCode" = ${warehouseCode} AND "skuCode" = ${master}
    `;
  }
}
