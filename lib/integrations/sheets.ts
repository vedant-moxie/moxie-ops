import { google } from "googleapis";
import { env, requireEnv } from "@/lib/env";
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

// 30-second in-memory cache to avoid hammering the Sheets API on each keystroke.
let cache: { at: number; data: AtpRow[] } | null = null;
const CACHE_MS = 30_000;

function getSheets() {
  requireEnv("sheets", [
    "GOOGLE_SHEETS_CLIENT_EMAIL",
    "GOOGLE_SHEETS_PRIVATE_KEY",
    "INVENTORY_SPREADSHEET_ID",
  ]);
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SHEETS_CLIENT_EMAIL,
    key: env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * Read live ATP from the inventory Google Sheet.
 * Expected columns: SKU code | On hand | Reserved | Safety stock.
 * When Sheets isn't configured, falls back to the live WMS WarehouseStock mirror
 * (free saleable stock = ATP), and only then to the latest DB inventory snapshot.
 */
export async function readLiveAtp(opts: { force?: boolean } = {}): Promise<AtpRow[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const skus = await prisma.sku.findMany({
    where: { active: true },
    select: { id: true, internalCode: true, name: true, casePackSize: true },
  });
  const skuByCode = new Map(skus.map((s) => [s.internalCode, s]));

  // No Sheets credentials → serve live WMS free stock (or a DB snapshot if empty).
  if (!env.GOOGLE_SHEETS_CLIENT_EMAIL || !env.INVENTORY_SPREADSHEET_ID) {
    const data = (await readAtpFromWarehouseStock(skus)) ?? (await readAtpFromSnapshots(skus));
    cache = { at: Date.now(), data };
    return data;
  }

  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.INVENTORY_SPREADSHEET_ID,
      range: "Inventory!A2:D",
    });
    const rows = res.data.values ?? [];
    const data: AtpRow[] = [];
    for (const row of rows) {
      const [code, onHand, reserved, safety] = row;
      const sku = skuByCode.get(String(code).trim());
      if (!sku) continue;
      const onHandQty = Number(onHand) || 0;
      const reservedQty = Number(reserved) || 0;
      const safetyStock = Number(safety) || 0;
      data.push({
        skuId: sku.id,
        internalCode: sku.internalCode,
        name: sku.name,
        onHandQty,
        reservedQty,
        safetyStock,
        atpQty: onHandQty - reservedQty - safetyStock,
        casePackSize: sku.casePackSize,
      });
    }
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.error("[sheets] read failed, falling back to WMS stock / snapshot", err);
    const data = (await readAtpFromWarehouseStock(skus)) ?? (await readAtpFromSnapshots(skus));
    cache = { at: Date.now(), data };
    return data;
  }
}

/**
 * Computes ATP from the live WMS WarehouseStock mirror: free saleable stock
 * summed across warehouses per master SKU. Channel-specific Sku codes resolve to
 * their master code first (e.g. a Blinkit item id → "WLIC50"). Returns null when
 * the mirror is empty so the caller can fall back to inventory snapshots.
 */
async function readAtpFromWarehouseStock(
  skus: { id: string; internalCode: string; name: string; casePackSize: number }[],
): Promise<AtpRow[] | null> {
  const stockRows = await prisma.warehouseStock.findMany({
    select: { skuCode: true, freeQty: true, totalQty: true, lockedQty: true },
  });
  if (stockRows.length === 0) return null;

  // master code → stock aggregated across all warehouses
  const byMaster = new Map<string, { free: number; total: number; locked: number }>();
  for (const r of stockRows) {
    const cur = byMaster.get(r.skuCode) ?? { free: 0, total: 0, locked: 0 };
    cur.free += r.freeQty;
    cur.total += r.totalQty;
    cur.locked += r.lockedQty;
    byMaster.set(r.skuCode, cur);
  }

  return skus.map((sku) => {
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
}

async function readAtpFromSnapshots(
  skus: { id: string; internalCode: string; name: string; casePackSize: number }[],
): Promise<AtpRow[]> {
  const result: AtpRow[] = [];
  for (const sku of skus) {
    const snap = await prisma.inventorySnapshot.findFirst({
      where: { skuId: sku.id },
      orderBy: { snapshotAt: "desc" },
    });
    result.push({
      skuId: sku.id,
      internalCode: sku.internalCode,
      name: sku.name,
      onHandQty: snap?.onHandQty ?? 0,
      reservedQty: snap?.reservedQty ?? 0,
      safetyStock: snap?.safetyStock ?? 0,
      atpQty: snap?.atpQty ?? 0,
      casePackSize: sku.casePackSize,
    });
  }
  return result;
}

export function invalidateAtpCache() {
  cache = null;
}
