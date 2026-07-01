-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "emailHoldReason" TEXT,
ADD COLUMN     "emailStatus" TEXT NOT NULL DEFAULT 'NOT_SENT';
