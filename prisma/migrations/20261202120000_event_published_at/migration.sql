-- When an event first went on sale ("Just announced" ranks by it).
ALTER TABLE "Event" ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- Events already on sale: the best date we have is when they were created.
UPDATE "Event" SET "publishedAt" = "createdAt" WHERE "status" = 'PUBLISHED';
