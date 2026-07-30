-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NetWorthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetWorthSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "NetWorthAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NetWorthSnapshot" ("accountId", "balanceCents", "capturedAt", "id", "type", "userId") SELECT "accountId", "balanceCents", "capturedAt", "id", "type", "userId" FROM "NetWorthSnapshot";
DROP TABLE "NetWorthSnapshot";
ALTER TABLE "new_NetWorthSnapshot" RENAME TO "NetWorthSnapshot";
CREATE INDEX "NetWorthSnapshot_userId_capturedAt_idx" ON "NetWorthSnapshot"("userId", "capturedAt");
CREATE INDEX "NetWorthSnapshot_accountId_capturedAt_idx" ON "NetWorthSnapshot"("accountId", "capturedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
