// One-off live test: pulls the WMS stock report and mirrors it into WarehouseStock.
import { syncWmsStock } from "../lib/services/wms-stock-sync";
import { prisma } from "../lib/db";

async function main() {
  const res = await syncWmsStock();
  console.log("sync result:", res);
  const sample = await prisma.warehouseStock.findMany({
    where: { skuCode: "CAHHO100" },
    orderBy: { warehouseCode: "asc" },
  });
  console.table(sample.map((r) => ({
    wh: r.warehouseCode, sku: r.skuCode, total: r.totalQty, locked: r.lockedQty, free: r.freeQty, syncedAt: r.syncedAt.toISOString(),
  })));
  const counts = await prisma.warehouseStock.groupBy({ by: ["warehouseCode"], _count: true });
  console.log("rows per warehouse:", counts);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
