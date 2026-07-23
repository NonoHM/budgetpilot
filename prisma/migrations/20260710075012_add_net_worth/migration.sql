-- CreateTable
CREATE TABLE "NetWorthAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NetWorthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NetWorthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetWorthSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "NetWorthAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "NetWorthAccount_userId_idx" ON "NetWorthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NetWorthAccount_userId_name_key" ON "NetWorthAccount"("userId", "name");

-- CreateIndex
CREATE INDEX "NetWorthSnapshot_userId_capturedAt_idx" ON "NetWorthSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "NetWorthSnapshot_accountId_capturedAt_idx" ON "NetWorthSnapshot"("accountId", "capturedAt");
