ALTER TABLE "Campaign" ADD COLUMN "timingMode" TEXT NOT NULL DEFAULT 'DAILY';
ALTER TABLE "Campaign" ADD COLUMN "timingUpdatedAt" DATETIME;
ALTER TABLE "Transfer" ADD COLUMN "resourceReadyAt" DATETIME;
ALTER TABLE "Transfer" ADD COLUMN "resourceCheckAt" DATETIME;
ALTER TABLE "Transfer" ADD COLUMN "resourceRequired" INTEGER;
