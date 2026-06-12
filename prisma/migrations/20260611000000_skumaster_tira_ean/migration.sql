-- Baseline: the "Tira Code (SAP)" + EAN columns were previously applied to the
-- database via `prisma db push` without a migration file. This records that
-- change in migration history so the schema and history stay in sync. The
-- columns already exist on environments that were `db push`-ed; on a fresh
-- database this creates them.
ALTER TABLE "SkuMaster" ADD COLUMN "tiraCode" TEXT;
ALTER TABLE "SkuMaster" ADD COLUMN "ean" TEXT;

CREATE INDEX "SkuMaster_tiraCode_idx" ON "SkuMaster"("tiraCode");
