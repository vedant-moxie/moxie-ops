-- Standard-platform listing IDs from the Beauty Comm "Product Master" sheet.
ALTER TABLE "SkuMaster" ADD COLUMN "myntraCode" TEXT;
ALTER TABLE "SkuMaster" ADD COLUMN "purplleCode" TEXT;
ALTER TABLE "SkuMaster" ADD COLUMN "nykaaPids" TEXT;
ALTER TABLE "SkuMaster" ADD COLUMN "purpllePids" TEXT;

CREATE INDEX "SkuMaster_myntraCode_idx" ON "SkuMaster"("myntraCode");
CREATE INDEX "SkuMaster_purplleCode_idx" ON "SkuMaster"("purplleCode");
