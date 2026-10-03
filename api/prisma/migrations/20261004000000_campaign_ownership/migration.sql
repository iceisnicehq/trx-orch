ALTER TABLE "Transfer" ADD COLUMN "approvalSource" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "campaignId" TEXT REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD COLUMN "campaignDay" INTEGER;
ALTER TABLE "Transfer" ADD COLUMN "plannedAt" DATETIME;
ALTER TABLE "Transfer" ADD COLUMN "dependsOnId" TEXT;
ALTER TABLE "EngineState" ADD COLUMN "activeCampaignId" TEXT;
ALTER TABLE "EngineState" ADD COLUMN "teacherConfigAddress" TEXT;
UPDATE "EngineState" SET "teacherConfigAddress" = "teacherAddress";
CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL PRIMARY KEY, "seed" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE', "startedAt" DATETIME NOT NULL,
  "deadlineAt" DATETIME NOT NULL, "mixingDays" INTEGER NOT NULL, "totalDays" INTEGER NOT NULL,
  "returnReason" TEXT, "payAfterReturn" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "CampaignMember" (
  "campaignId" TEXT NOT NULL, "address" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "profileJson" TEXT NOT NULL,
  PRIMARY KEY ("campaignId","address"), FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "Allocation" (
  "transferId" TEXT NOT NULL, "ownerAddress" TEXT NOT NULL, "amountSun" INTEGER NOT NULL,
  PRIMARY KEY ("transferId","ownerAddress"), FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Allocation_ownerAddress_idx" ON "Allocation"("ownerAddress");
CREATE TABLE "OwnershipBalance" (
  "campaignId" TEXT NOT NULL, "ownerAddress" TEXT NOT NULL, "holderAddress" TEXT NOT NULL, "amountSun" INTEGER NOT NULL,
  PRIMARY KEY ("campaignId","ownerAddress","holderAddress"), FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Transfer_campaignId_sequence_idx" ON "Transfer"("campaignId","sequence");
