-- AlterTable
ALTER TABLE "OrganizerDebt" ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;


-- Donation debts: the whole refund was the organizer's.
UPDATE "OrganizerDebt" SET "refundedCents" = "cents" WHERE "kind" = 'DONATION';
