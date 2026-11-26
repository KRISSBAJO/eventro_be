-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "pendingEdit" JSONB,
ADD COLUMN     "pendingEditNote" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "refundOwedCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DateChange" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventDateId" TEXT,
    "fromStartsAt" TIMESTAMP(3) NOT NULL,
    "toStartsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "refundUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DateChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DateChange_eventId_createdAt_idx" ON "DateChange"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "DateChange" ADD CONSTRAINT "DateChange_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

