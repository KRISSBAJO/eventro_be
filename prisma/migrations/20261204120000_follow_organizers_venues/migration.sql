-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "slug" TEXT;

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "venueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Follow_orgId_idx" ON "Follow"("orgId");

-- CreateIndex
CREATE INDEX "Follow_venueId_idx" ON "Follow"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_userId_orgId_key" ON "Follow"("userId", "orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_userId_venueId_key" ON "Follow"("userId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A follow is of an organizer or a venue, never both or neither.
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_one_target" CHECK (("orgId" IS NULL) <> ("venueId" IS NULL));

-- Organizers that already exist get a page address from their name, plus 4 characters so names can repeat.
UPDATE "Organization"
SET "slug" = COALESCE(NULLIF(LEFT(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER("name"), '[^a-z0-9]+', '-', 'g')), 60), ''), 'organizer')
  || '-' || SUBSTR(MD5("id"), 1, 4)
WHERE "slug" IS NULL;
