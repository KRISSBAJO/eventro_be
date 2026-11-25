-- AlterTable
ALTER TABLE "Hold" ADD COLUMN     "donationCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "donationOwedCents" INTEGER NOT NULL DEFAULT 0;

