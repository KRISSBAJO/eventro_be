-- CreateTable
CREATE TABLE "OrganizerDebt" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orderId" TEXT,
    "kind" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizerDebt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizerDebt_orgId_createdAt_idx" ON "OrganizerDebt"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizerDebt" ADD CONSTRAINT "OrganizerDebt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Donation refunds already recorded as owed (Order.donationOwedCents) start the ledger.
INSERT INTO "OrganizerDebt" ("id", "orgId", "orderId", "kind", "cents", "currency", "createdAt")
SELECT 'debt_' || o."id", e."orgId", o."id", 'DONATION', o."donationOwedCents", o."currency", CURRENT_TIMESTAMP
FROM "Order" o JOIN "Event" e ON e."id" = o."eventId"
WHERE o."donationOwedCents" > 0;
