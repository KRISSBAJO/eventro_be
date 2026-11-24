-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "resaleCapPercent" INTEGER DEFAULT 150,
ADD COLUMN     "resaleEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resaleRoyaltyPermille" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transferCutoffMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "transfersEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "resaleListingId" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "resoldAt" TIMESTAMP(3),
ADD COLUMN     "transferExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ResaleListing" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "faceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "heldUntil" TIMESTAMP(3),
    "heldBy" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soldAt" TIMESTAMP(3),
    "sellerFeeCents" INTEGER,
    "royaltyCents" INTEGER,
    "payoutCents" INTEGER,
    "payoutStatus" TEXT NOT NULL DEFAULT 'NONE',
    "payoutAvailableAt" TIMESTAMP(3),
    "paidOutAt" TIMESTAMP(3),
    "payoutNote" TEXT,

    CONSTRAINT "ResaleListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResaleListing_eventId_status_idx" ON "ResaleListing"("eventId", "status");

-- CreateIndex
CREATE INDEX "ResaleListing_sellerId_idx" ON "ResaleListing"("sellerId");

-- CreateIndex
CREATE INDEX "ResaleListing_payoutStatus_idx" ON "ResaleListing"("payoutStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Order_resaleListingId_key" ON "Order"("resaleListingId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_resaleListingId_fkey" FOREIGN KEY ("resaleListingId") REFERENCES "ResaleListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResaleListing" ADD CONSTRAINT "ResaleListing_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResaleListing" ADD CONSTRAINT "ResaleListing_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

