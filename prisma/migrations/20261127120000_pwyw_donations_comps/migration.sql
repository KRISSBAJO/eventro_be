-- CreateEnum
CREATE TYPE "TicketPricing" AS ENUM ('FIXED', 'PWYW');

-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('SALE', 'COMP');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "compLimit" INTEGER,
ADD COLUMN     "donationCause" TEXT,
ADD COLUMN     "donationDescription" TEXT,
ADD COLUMN     "donationMinCents" INTEGER,
ADD COLUMN     "donationSuggestedCents" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "donationsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Hold" ADD COLUMN     "amountCents" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "compGroup" TEXT,
ADD COLUMN     "compIssuedById" TEXT,
ADD COLUMN     "compNote" TEXT,
ADD COLUMN     "compRevokedAt" TIMESTAMP(3),
ADD COLUMN     "donationCause" TEXT,
ADD COLUMN     "donationCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "donationRefundedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" "OrderKind" NOT NULL DEFAULT 'SALE';

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "pricing" "TicketPricing" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "pwywMaxCents" INTEGER,
ADD COLUMN     "pwywMinCents" INTEGER,
ADD COLUMN     "pwywQuickPicks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "pwywSuggestedCents" INTEGER;

-- CreateTable
CREATE TABLE "GuestListEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "plusOnes" INTEGER NOT NULL DEFAULT 0,
    "group" TEXT,
    "note" TEXT,
    "arrived" INTEGER NOT NULL DEFAULT 0,
    "firstArrivedAt" TIMESTAMP(3),
    "lastArrivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestCheckIn" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "entryId" TEXT,
    "guests" INTEGER NOT NULL,
    "result" "ScanResult" NOT NULL,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "deviceId" TEXT,
    "userId" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuestListEntry_eventId_name_idx" ON "GuestListEntry"("eventId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GuestCheckIn_dedupeKey_key" ON "GuestCheckIn"("dedupeKey");

-- CreateIndex
CREATE INDEX "GuestCheckIn_eventId_at_idx" ON "GuestCheckIn"("eventId", "at");

-- CreateIndex
CREATE INDEX "GuestCheckIn_entryId_at_idx" ON "GuestCheckIn"("entryId", "at");

-- CreateIndex
CREATE INDEX "Order_eventId_kind_idx" ON "Order"("eventId", "kind");

-- AddForeignKey
ALTER TABLE "GuestListEntry" ADD CONSTRAINT "GuestListEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestCheckIn" ADD CONSTRAINT "GuestCheckIn_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestCheckIn" ADD CONSTRAINT "GuestCheckIn_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "GuestListEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

