-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "bankAccountName" TEXT,
ADD COLUMN     "bankCode" TEXT,
ADD COLUMN     "payoutHoldUntil" TIMESTAMP(3),
ADD COLUMN     "payoutProvider" TEXT,
ADD COLUMN     "payoutUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "paystackSubaccount" TEXT;

