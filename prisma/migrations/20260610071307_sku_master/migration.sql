-- CreateTable
CREATE TABLE "SkuMaster" (
    "id" TEXT NOT NULL,
    "internalCode" TEXT NOT NULL,
    "name" TEXT,
    "hsnCode" TEXT,
    "gstRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mrp" DOUBLE PRECISION,
    "taxableB2B" DOUBLE PRECISION,
    "zeptoCode" TEXT,
    "nykaaCode" TEXT,
    "instamartCode" TEXT,
    "blinkitCode" TEXT,
    "taxableZepto" DOUBLE PRECISION,
    "taxableNykaa" DOUBLE PRECISION,
    "taxableInstamart" DOUBLE PRECISION,
    "taxableMyntra" DOUBLE PRECISION,
    "taxableBlinkit" DOUBLE PRECISION,
    "taxableReliance" DOUBLE PRECISION,
    "taxableAmazonNow" DOUBLE PRECISION,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkuMaster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuMaster_internalCode_key" ON "SkuMaster"("internalCode");

-- CreateIndex
CREATE INDEX "SkuMaster_blinkitCode_idx" ON "SkuMaster"("blinkitCode");

-- CreateIndex
CREATE INDEX "SkuMaster_zeptoCode_idx" ON "SkuMaster"("zeptoCode");

-- CreateIndex
CREATE INDEX "SkuMaster_nykaaCode_idx" ON "SkuMaster"("nykaaCode");

-- CreateIndex
CREATE INDEX "SkuMaster_instamartCode_idx" ON "SkuMaster"("instamartCode");
