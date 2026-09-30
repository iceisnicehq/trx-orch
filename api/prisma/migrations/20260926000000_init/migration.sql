CREATE TABLE "Wallet" ("address" TEXT NOT NULL PRIMARY KEY, "ordinal" INTEGER NOT NULL, "autoApprove" BOOLEAN NOT NULL DEFAULT false, "balanceSnapshotSun" INTEGER NOT NULL DEFAULT 1000000);
CREATE UNIQUE INDEX "Wallet_ordinal_key" ON "Wallet"("ordinal");
CREATE TABLE "Transfer" ("id" TEXT NOT NULL PRIMARY KEY, "sequence" INTEGER NOT NULL, "kind" TEXT NOT NULL, "status" TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL, "amountSun" INTEGER NOT NULL, "scheduledAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, "txId" TEXT, "signedJson" TEXT, "note" TEXT, CONSTRAINT "Transfer_from_fkey" FOREIGN KEY ("from") REFERENCES "Wallet" ("address") ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE UNIQUE INDEX "Transfer_sequence_key" ON "Transfer"("sequence");
CREATE UNIQUE INDEX "Transfer_txId_key" ON "Transfer"("txId");
CREATE INDEX "Transfer_status_sequence_idx" ON "Transfer"("status","sequence");
CREATE TABLE "EngineState" ("id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1, "phase" TEXT NOT NULL DEFAULT 'IDLE', "status" TEXT NOT NULL DEFAULT 'Ready. Start to create a 24-hour plan.', "teacherAddress" TEXT NOT NULL, "teacherBaseline" INTEGER NOT NULL, "nextSequence" INTEGER NOT NULL DEFAULT 1, "lastPlanAt" DATETIME, "fatalReason" TEXT, "updatedAt" DATETIME NOT NULL);
CREATE TABLE "Audit" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "event" TEXT NOT NULL, "detail" TEXT NOT NULL, "transferId" TEXT);
CREATE INDEX "Audit_at_idx" ON "Audit"("at");
