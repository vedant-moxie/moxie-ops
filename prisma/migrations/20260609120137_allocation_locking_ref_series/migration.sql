-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedById" TEXT,
ADD COLUMN     "claimedByLabel" TEXT;

-- CreateTable
CREATE TABLE "Counter" (
    "key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "PurchaseOrder_claimedById_idx" ON "PurchaseOrder"("claimedById");
