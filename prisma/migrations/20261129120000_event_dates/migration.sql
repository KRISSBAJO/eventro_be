-- CreateEnum
CREATE TYPE "DateMode" AS ENUM ('SINGLE', 'DATES', 'DAYS');

-- CreateEnum
CREATE TYPE "EventDateStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ScanResult" ADD VALUE 'WRONG_DATE';

-- DropIndex
DROP INDEX "Ticket_eventId_section_row_seat_key";

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "dateMode" "DateMode" NOT NULL DEFAULT 'SINGLE';

-- AlterTable
ALTER TABLE "GuaranteeClaim" ADD COLUMN     "eventDateId" TEXT;

-- AlterTable
ALTER TABLE "ScanAttempt" ADD COLUMN     "eventDateId" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "dateKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "eventDateId" TEXT;

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "eventDateId" TEXT,
ADD COLUMN     "tierKey" TEXT,
ADD COLUMN     "validDateIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "EventDate" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "doorsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "label" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "EventDateStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCheckIn" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "eventDateId" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "byUserId" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventDate_eventId_startsAt_idx" ON "EventDate"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "TicketCheckIn_eventDateId_idx" ON "TicketCheckIn"("eventDateId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketCheckIn_ticketId_eventDateId_key" ON "TicketCheckIn"("ticketId", "eventDateId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_eventId_dateKey_section_row_seat_key" ON "Ticket"("eventId", "dateKey", "section", "row", "seat");

-- CreateIndex
CREATE INDEX "TicketType_eventDateId_idx" ON "TicketType"("eventDateId");

-- AddForeignKey
ALTER TABLE "EventDate" ADD CONSTRAINT "EventDate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_eventDateId_fkey" FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventDateId_fkey" FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_eventDateId_fkey" FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

