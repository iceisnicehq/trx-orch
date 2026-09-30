CREATE TABLE "TelegramCursor" (
    "channelId" TEXT NOT NULL PRIMARY KEY,
    "pinnedMessageId" INTEGER NOT NULL,
    "lastAuditId" INTEGER NOT NULL DEFAULT 0,
    "lastQueueHash" TEXT,
    "nextQueueAttemptAt" DATETIME,
    "queueLastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "TelegramDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "auditId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "messageId" INTEGER,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "TelegramDelivery_channelId_auditId_key" ON "TelegramDelivery"("channelId", "auditId");
CREATE INDEX "TelegramDelivery_channelId_status_nextAttemptAt_idx" ON "TelegramDelivery"("channelId", "status", "nextAttemptAt");
