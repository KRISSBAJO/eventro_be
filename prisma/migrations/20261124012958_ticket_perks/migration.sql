-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "badge" TEXT,
ADD COLUMN     "perks" TEXT[] DEFAULT ARRAY[]::TEXT[];
