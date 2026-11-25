-- CreateEnum
CREATE TYPE "ScanResult" AS ENUM ('ADMITTED', 'ALREADY_USED', 'VOID', 'WRONG_EVENT', 'INVALID', 'EXPIRED_CODE', 'NOT_FOUND', 'TRANSFER_PENDING');

-- CreateEnum
CREATE TYPE "ScanMethod" AS ENUM ('QR', 'MANUAL', 'OFFLINE');

-- CreateEnum
CREATE TYPE "GuaranteeClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "resaleGuarantee" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ScanAttempt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketId" TEXT,
    "result" "ScanResult" NOT NULL,
    "method" "ScanMethod" NOT NULL,
    "deviceId" TEXT,
    "userId" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuaranteeClaim" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "GuaranteeClaimStatus" NOT NULL DEFAULT 'PENDING',
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "refundStatus" TEXT NOT NULL DEFAULT 'NONE',
    "refundError" TEXT,
    "refundedAt" TIMESTAMP(3),
    "noticesSent" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuaranteeClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScanAttempt_dedupeKey_key" ON "ScanAttempt"("dedupeKey");

-- CreateIndex
CREATE INDEX "ScanAttempt_ticketId_at_idx" ON "ScanAttempt"("ticketId", "at");

-- CreateIndex
CREATE INDEX "ScanAttempt_eventId_at_idx" ON "ScanAttempt"("eventId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "GuaranteeClaim_ticketId_key" ON "GuaranteeClaim"("ticketId");

-- CreateIndex
CREATE INDEX "GuaranteeClaim_status_createdAt_idx" ON "GuaranteeClaim"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GuaranteeClaim_refundStatus_idx" ON "GuaranteeClaim"("refundStatus");

-- CreateIndex
CREATE INDEX "GuaranteeClaim_eventId_idx" ON "GuaranteeClaim"("eventId");

-- AddForeignKey
ALTER TABLE "ScanAttempt" ADD CONSTRAINT "ScanAttempt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanAttempt" ADD CONSTRAINT "ScanAttempt_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuaranteeClaim" ADD CONSTRAINT "GuaranteeClaim_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuaranteeClaim" ADD CONSTRAINT "GuaranteeClaim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuaranteeClaim" ADD CONSTRAINT "GuaranteeClaim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: tickets already bought on fan resale are covered too.
UPDATE "Ticket" SET "resaleGuarantee" = true
WHERE "orderId" IN (SELECT "id" FROM "Order" WHERE "resaleListingId" IS NOT NULL);
