ALTER TABLE "Wallet" ADD COLUMN "mixEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Wallet" ADD COLUMN "joined" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Wallet" ADD COLUMN "entryBalanceSun" INTEGER;
UPDATE "EngineState" SET "status" = 'Ready. Select at least two funded wallets, then Start.'
WHERE "phase" = 'IDLE' AND "status" = 'Ready. Start to create a 24-hour plan.';
