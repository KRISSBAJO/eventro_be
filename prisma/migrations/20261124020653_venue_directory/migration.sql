-- AlterTable
ALTER TABLE "Venue" ADD COLUMN     "about" TEXT,
ADD COLUMN     "hiddenAt" TIMESTAMP(3),
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "website" TEXT;

-- CreateTable
CREATE TABLE "VenueClaim" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "website" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueClaim_status_createdAt_idx" ON "VenueClaim"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VenueClaim_venueId_userId_key" ON "VenueClaim"("venueId", "userId");

-- AddForeignKey
ALTER TABLE "VenueClaim" ADD CONSTRAINT "VenueClaim_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueClaim" ADD CONSTRAINT "VenueClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
