-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "minAge" INTEGER,
ADD COLUMN     "presaleCode" TEXT,
ADD COLUMN     "presaleStartsAt" TIMESTAMP(3),
ADD COLUMN     "questions" JSONB;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "answers" JSONB;

-- CreateTable
CREATE TABLE "EventReport" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "userId" TEXT,
    "clientIp" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventReport_status_createdAt_idx" ON "EventReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EventReport_eventId_idx" ON "EventReport"("eventId");

-- CreateIndex
CREATE INDEX "EventReport_clientIp_createdAt_idx" ON "EventReport"("clientIp", "createdAt");

-- AddForeignKey
ALTER TABLE "EventReport" ADD CONSTRAINT "EventReport_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

