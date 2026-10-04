ALTER TABLE "EngineState" ADD COLUMN "selectedPlanVariantId" TEXT;
CREATE TABLE "PlanVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" INTEGER NOT NULL,
    "membersJson" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "anchorAt" DATETIME NOT NULL,
    "deadlineAt" DATETIME NOT NULL,
    "totalDays" INTEGER NOT NULL,
    "generatorVersion" INTEGER NOT NULL DEFAULT 2,
    "parentId" TEXT,
    "sourceCampaignId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PlanVariant_number_key" ON "PlanVariant"("number");
ALTER TABLE "Campaign" ADD COLUMN "planVariantId" TEXT REFERENCES "PlanVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD COLUMN "executionStartedAt" DATETIME;
ALTER TABLE "Transfer" ADD COLUMN "pacingAfterId" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "pacingDelayMs" INTEGER;
