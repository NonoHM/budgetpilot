-- CreateTable
CREATE TABLE "RecurringStreamAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "anchorTransactionIds" TEXT NOT NULL,
    "dueDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecurringStreamAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RecurringStreamAction_userId_idx" ON "RecurringStreamAction"("userId");

-- CreateIndex
CREATE INDEX "RecurringStreamAction_userId_kind_idx" ON "RecurringStreamAction"("userId", "kind");
