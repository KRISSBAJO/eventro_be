-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "reviewAskedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EventReview" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'VISIBLE',
    "hideReason" TEXT,
    "hiddenBy" TEXT,
    "reply" TEXT,
    "repliedAt" TIMESTAMP(3),
    "repliedBy" TEXT,
    "flags" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventReviewFlag" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventReviewFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventReview_orgId_status_idx" ON "EventReview"("orgId", "status");

-- CreateIndex
CREATE INDEX "EventReview_flags_idx" ON "EventReview"("flags");

-- CreateIndex
CREATE UNIQUE INDEX "EventReview_eventId_userId_key" ON "EventReview"("eventId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventReviewFlag_reviewId_userId_key" ON "EventReviewFlag"("reviewId", "userId");

-- AddForeignKey
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventReviewFlag" ADD CONSTRAINT "EventReviewFlag_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "EventReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

