-- AlterTable
ALTER TABLE "Venue" ADD COLUMN     "photos" JSONB;


-- Venues that already have a cover photo start their gallery with it.
UPDATE "Venue" SET "photos" = jsonb_build_array(jsonb_build_object('url', "imageUrl")) WHERE "imageUrl" IS NOT NULL AND "photos" IS NULL;
