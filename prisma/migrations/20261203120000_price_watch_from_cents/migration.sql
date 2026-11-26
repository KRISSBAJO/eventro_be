-- Watching: the lowest price when a watch started, so the list can say the price dropped since.
ALTER TABLE "PriceWatch" ADD COLUMN     "fromCents" INTEGER;

-- Watches already on start from today's lowest live price (tier copies of cancelled dates left out).
UPDATE "PriceWatch" pw SET "fromCents" = (
  SELECT MIN(tt."priceCents") FROM "TicketType" tt
  WHERE tt."eventId" = pw."eventId"
    AND (tt."eventDateId" IS NULL OR EXISTS (SELECT 1 FROM "EventDate" d WHERE d."id" = tt."eventDateId" AND d."status" = 'ACTIVE'))
) WHERE pw."stoppedAt" IS NULL;
