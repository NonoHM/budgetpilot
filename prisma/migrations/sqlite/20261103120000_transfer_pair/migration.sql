-- A confirmed transfer between two of a member's own accounts (#1189): one nullable column on
-- Transaction, stored on both legs, unique, and a self-referencing foreign key that SETS NULL, so
-- deleting one leg unlinks the other on every delete path.
--
-- Additive: no existing row changes and no value is stamped. Prisma's statements, unchanged, so
-- `prisma migrate diff` still matches. `migrate deploy` wraps nothing in a transaction: a failure
-- between statements leaves the migration marked failed and the boot refuses to start, and since
-- every existing row keeps its values and the new column is NULL everywhere, no stored figure is
-- damaged. Not restartable as a file (ADD COLUMN is not idempotent); recovery is by hand from the
-- statement that failed onward.
--
-- SQLite adds a foreign key by rebuilding the table (new table, copy, drop, rename), as
-- 20260821120000 does. Other tables reference "Transaction" by name, so the rename restores them.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "date" DATETIME NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "type" TEXT,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "bankOperationType" TEXT,
    "manualCategory" TEXT,
    "manualCategoryKey" TEXT,
    "natureManual" TEXT,
    "dedupeKey" TEXT,
    "dedupeKeyHash" TEXT,
    "metadataJson" TEXT,
    "transferPairId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_transferPairId_fkey" FOREIGN KEY ("transferPairId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("accountId", "amountCents", "bankOperationType", "categoryId", "createdAt", "currency", "date", "dedupeKey", "dedupeKeyHash", "exponent", "id", "importBatchId", "label", "manualCategory", "manualCategoryKey", "metadataJson", "natureManual", "notes", "source", "type", "updatedAt", "userId") SELECT "accountId", "amountCents", "bankOperationType", "categoryId", "createdAt", "currency", "date", "dedupeKey", "dedupeKeyHash", "exponent", "id", "importBatchId", "label", "manualCategory", "manualCategoryKey", "metadataJson", "natureManual", "notes", "source", "type", "updatedAt", "userId" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE UNIQUE INDEX "Transaction_transferPairId_key" ON "Transaction"("transferPairId");
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_source_idx" ON "Transaction"("source");
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");
CREATE INDEX "Transaction_userId_date_idx" ON "Transaction"("userId", "date");
CREATE INDEX "Transaction_userId_accountId_date_idx" ON "Transaction"("userId", "accountId", "date");
CREATE INDEX "Transaction_userId_manualCategory_idx" ON "Transaction"("userId", "manualCategory");
CREATE INDEX "Transaction_userId_manualCategoryKey_idx" ON "Transaction"("userId", "manualCategoryKey");
CREATE INDEX "Transaction_userId_categoryId_idx" ON "Transaction"("userId", "categoryId");
CREATE INDEX "Transaction_userId_natureManual_idx" ON "Transaction"("userId", "natureManual");
CREATE UNIQUE INDEX "Transaction_userId_dedupeKeyHash_key" ON "Transaction"("userId", "dedupeKeyHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

