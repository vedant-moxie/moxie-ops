-- CreateTable
CREATE TABLE "WarehouseStock" (
    "id" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "skuCode" TEXT NOT NULL,
    "totalQty" INTEGER NOT NULL DEFAULT 0,
    "lockedQty" INTEGER NOT NULL DEFAULT 0,
    "wmsFreeQty" INTEGER NOT NULL DEFAULT 0,
    "freeQty" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarehouseStock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarehouseStock_skuCode_idx" ON "WarehouseStock"("skuCode");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseStock_warehouseCode_skuCode_key" ON "WarehouseStock"("warehouseCode", "skuCode");
