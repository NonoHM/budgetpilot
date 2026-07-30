-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "netWorthAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Account_netWorthAccountId_fkey" FOREIGN KEY ("netWorthAccountId") REFERENCES "NetWorthAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Account" ("createdAt", "currency", "id", "name", "source", "updatedAt", "userId") SELECT "createdAt", "currency", "id", "name", "source", "updatedAt", "userId" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE INDEX "Account_userId_idx" ON "Account"("userId");
CREATE INDEX "Account_source_idx" ON "Account"("source");
CREATE INDEX "Account_netWorthAccountId_idx" ON "Account"("netWorthAccountId");
CREATE UNIQUE INDEX "Account_userId_name_source_key" ON "Account"("userId", "name", "source");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
