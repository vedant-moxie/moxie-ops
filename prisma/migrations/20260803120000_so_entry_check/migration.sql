-- CreateEnum
CREATE TYPE "SoCheckResult" AS ENUM ('MATCHED', 'QTY_MISMATCH', 'REF_MISSING', 'MISSING_SO', 'DUPLICATE_SO', 'STALE_REVISION');

-- CreateTable
CREATE TABLE "WmsSalesOrderMirror" (
    "id" TEXT NOT NULL,
    "wmsSalesOrderId" TEXT NOT NULL,
    "orderNo" TEXT,
    "refNo" TEXT,
    "partyRefOrderNo" TEXT,
    "warehouseCode" TEXT,
    "orderDate" TIMESTAMP(3),
    "status" TEXT,
    "lines" JSONB NOT NULL,
    "poId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WmsSalesOrderMirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SoCheck" (
    "poId" TEXT NOT NULL,
    "result" "SoCheckResult" NOT NULL,
    "ourQty" INTEGER NOT NULL DEFAULT 0,
    "wmsQty" INTEGER NOT NULL DEFAULT 0,
    "soCount" INTEGER NOT NULL DEFAULT 0,
    "diff" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "note" TEXT,

    CONSTRAINT "SoCheck_pkey" PRIMARY KEY ("poId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WmsSalesOrderMirror_wmsSalesOrderId_key" ON "WmsSalesOrderMirror"("wmsSalesOrderId");

-- CreateIndex
CREATE INDEX "WmsSalesOrderMirror_orderNo_idx" ON "WmsSalesOrderMirror"("orderNo");

-- CreateIndex
CREATE INDEX "WmsSalesOrderMirror_refNo_idx" ON "WmsSalesOrderMirror"("refNo");

-- CreateIndex
CREATE INDEX "WmsSalesOrderMirror_poId_idx" ON "WmsSalesOrderMirror"("poId");

-- CreateIndex
CREATE INDEX "SoCheck_result_idx" ON "SoCheck"("result");

-- AddForeignKey
ALTER TABLE "SoCheck" ADD CONSTRAINT "SoCheck_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
