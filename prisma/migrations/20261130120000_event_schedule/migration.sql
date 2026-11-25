-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('PERFORMANCE', 'TALK', 'WORKSHOP', 'BREAK', 'OTHER');

-- CreateTable
CREATE TABLE "ScheduleItem" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventDateId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "stage" TEXT,
    "people" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kind" "ScheduleKind" NOT NULL DEFAULT 'OTHER',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "bookable" BOOLEAN NOT NULL DEFAULT false,
    "capacity" INTEGER,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "eligibleTiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionReservation" (
    "id" TEXT NOT NULL,
    "scheduleItemId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "checkedInAt" TIMESTAMP(3),
    "checkedInBy" TEXT,

    CONSTRAINT "SessionReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleItem_eventId_startsAt_idx" ON "ScheduleItem"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "ScheduleItem_eventDateId_idx" ON "ScheduleItem"("eventDateId");

-- CreateIndex
CREATE INDEX "SessionReservation_ticketId_idx" ON "SessionReservation"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionReservation_scheduleItemId_ticketId_key" ON "SessionReservation"("scheduleItemId", "ticketId");

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleItem" ADD CONSTRAINT "ScheduleItem_eventDateId_fkey" FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionReservation" ADD CONSTRAINT "SessionReservation_scheduleItemId_fkey" FOREIGN KEY ("scheduleItemId") REFERENCES "ScheduleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionReservation" ADD CONSTRAINT "SessionReservation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

