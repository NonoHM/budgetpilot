-- CreateTable
CREATE TABLE "SavingsGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmountCents" INTEGER NOT NULL,
    "netWorthAccountId" TEXT,
    "currentAmountCents" INTEGER NOT NULL DEFAULT 0,
    "startingBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "targetDate" DATETIME,
    "reachedAt" DATETIME,
    "reachedBannerDismissedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SavingsGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SavingsGoal_netWorthAccountId_fkey" FOREIGN KEY ("netWorthAccountId") REFERENCES "NetWorthAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SavingsGoal_userId_idx" ON "SavingsGoal"("userId");

-- CreateIndex
CREATE INDEX "SavingsGoal_userId_deletedAt_idx" ON "SavingsGoal"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "SavingsGoal_netWorthAccountId_idx" ON "SavingsGoal"("netWorthAccountId");
