-- CreateTable
CREATE TABLE "SkuItemMapping" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "wmsCode" TEXT NOT NULL,
    "wmsDescription" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'ai',
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkuItemMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuItemMapping_skuId_key" ON "SkuItemMapping"("skuId");

-- CreateIndex
CREATE INDEX "SkuItemMapping_wmsCode_idx" ON "SkuItemMapping"("wmsCode");

-- CreateIndex
CREATE INDEX "SkuItemMapping_needsReview_idx" ON "SkuItemMapping"("needsReview");

-- AddForeignKey
ALTER TABLE "SkuItemMapping" ADD CONSTRAINT "SkuItemMapping_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
