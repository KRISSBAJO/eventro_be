-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "media" JSONB;

-- CreateTable
CREATE TABLE "MediaUpload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaUpload_userId_idx" ON "MediaUpload"("userId");
