-- CreateTable
CREATE TABLE "VenueListing" (
    "venueId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "priceMode" TEXT NOT NULL DEFAULT 'QUOTE',
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "minHours" INTEGER NOT NULL DEFAULT 1,
    "noticeDays" INTEGER NOT NULL DEFAULT 7,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 60,
    "capacity" INTEGER,
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rules" TEXT,
    "photos" JSONB,
    "instantBook" BOOLEAN NOT NULL DEFAULT false,
    "hours" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueListing_pkey" PRIMARY KEY ("venueId")
);

-- CreateTable
CREATE TABLE "VenueBlackout" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueBlackout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueBooking" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "requestedById" TEXT,
    "eventId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "blockFrom" TIMESTAMP(3) NOT NULL,
    "blockTo" TIMESTAMP(3) NOT NULL,
    "guests" INTEGER,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "holdUntil" TIMESTAMP(3) NOT NULL,
    "quotedCents" INTEGER,
    "currency" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueBookingMessage" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT,
    "side" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueBookingMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueListing_active_idx" ON "VenueListing"("active");

-- CreateIndex
CREATE INDEX "VenueBlackout_venueId_startsAt_idx" ON "VenueBlackout"("venueId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "VenueBooking_code_key" ON "VenueBooking"("code");

-- CreateIndex
CREATE UNIQUE INDEX "VenueBooking_eventId_key" ON "VenueBooking"("eventId");

-- CreateIndex
CREATE INDEX "VenueBooking_venueId_status_blockFrom_idx" ON "VenueBooking"("venueId", "status", "blockFrom");

-- CreateIndex
CREATE INDEX "VenueBooking_orgId_createdAt_idx" ON "VenueBooking"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "VenueBooking_status_holdUntil_idx" ON "VenueBooking"("status", "holdUntil");

-- CreateIndex
CREATE INDEX "VenueBookingMessage_bookingId_createdAt_idx" ON "VenueBookingMessage"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "VenueListing" ADD CONSTRAINT "VenueListing_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueBlackout" ADD CONSTRAINT "VenueBlackout_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueBooking" ADD CONSTRAINT "VenueBooking_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueBooking" ADD CONSTRAINT "VenueBooking_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueBooking" ADD CONSTRAINT "VenueBooking_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueBookingMessage" ADD CONSTRAINT "VenueBookingMessage_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "VenueBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

