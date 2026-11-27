-- DropIndex
DROP INDEX "Order_paymentRef_key";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "groupId" TEXT;

-- CreateIndex
CREATE INDEX "Order_groupId_idx" ON "Order"("groupId");

-- CreateIndex
CREATE INDEX "Order_paymentRef_idx" ON "Order"("paymentRef");

