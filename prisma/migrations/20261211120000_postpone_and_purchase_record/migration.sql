-- AlterTable
ALTER TABLE "DateChange" ADD COLUMN     "detail" JSONB,
ADD COLUMN     "emailed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'TIME',
ADD COLUMN     "ticketTypeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "postponeReason" TEXT,
ADD COLUMN     "postponedAt" TIMESTAMP(3),
ADD COLUMN     "postponedById" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "snapshot" JSONB;

