-- The dashboard KPI feed is header-only (plan 008 "SO read path"), so a mirrored SO can
-- carry no lines. Distinguish "no lines reported" from "zero units ordered", and record
-- the verdict that state produces.

-- AlterEnum
ALTER TYPE "SoCheckResult" ADD VALUE 'QTY_UNVERIFIED';

-- AlterTable
ALTER TABLE "WmsSalesOrderMirror" ADD COLUMN     "linesKnown" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "customer" TEXT;
