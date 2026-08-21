-- Every stored amount carries its own currency and its own exponent, and every money column is
-- 64-bit.
--
-- WHY THE PAIR IS A PAIR. A row written under a non-euro currency with no exponent beside it is
-- ambiguous forever: 1000 under JOD is either 10.00 or 1.000, and no later migration can decide
-- which, because the information was never stored. That is the one thing about multi-currency
-- that turns existing rows into a 2.0, so currency and exponent arrive together or not at all.
-- The exponent is STORED rather than derived from the code, for one reason that no other reason
-- supports: a code withdrawn from ISO 4217 has no published exponent anywhere, so a row whose
-- meaning depended on a list would stop being readable the moment the list moved.
--
-- WHY THE COLUMNS ARE WIDENED IN THE SAME CHANGE. `domain/netWorth.ts` caps net worth at
-- 1,000,000,000 minor units. At exponent 3 that is 10,000,000,000, about five times a signed
-- 32-bit column, so supporting the seven 3-decimal currencies means widening or silently
-- refusing the app's own stated cap for them. Value-preserving, therefore not breaking; expensive
-- on a grown table, therefore done now.
--
-- WHY THERE IS NO COLUMN DEFAULT, AND WHY THE STAMP IS AN EXPLICIT UPDATE. The shortcut is
-- `ADD COLUMN "exponent" INTEGER NOT NULL DEFAULT 2`, one statement instead of three. On
-- PostgreSQL it is exactly what this design refuses: MEASURED on 17.10, that leaves
-- `pg_attribute.atthasmissing` true with `attmissingval = {2}` and REWRITES NO ROW, so the value
-- is synthesised on read from the catalogue and there is nothing in any row to correct. The
-- three-step below leaves `atthasmissing` false, which is the observable difference. A row whose
-- exponent is corrected later would otherwise have a deduplication key describing a different
-- amount than the one stored: a default is a value with no author, and this is the class of
-- column where that is fatal rather than untidy. No default survives this migration, so a future
-- write path that forgets a denomination fails loudly instead of silently becoming euros.
--
-- WHY EVERY ROW IS STAMPED REGARDLESS OF `Transaction.type`. `type` is nullable and stays
-- nullable. A NULL-type row cannot be keyed, so it gets a NULL deduplication key and stays
-- invisible to deduplication, which is the existing behaviour for manual transactions rather than
-- a new rule. COUNTED on the one real install available: zero such rows. That says the state has
-- not OCCURRED there, not that it cannot. READ, and this is the half a count cannot give you:
-- server/backup/schema.ts declares `type` nullable in the backup contract and
-- server/backup/import.ts writes it verbatim, so restore is a production path that can write one
-- and 1.0 freezes that contract; server/transactions/totals.ts already carries a production
-- `{ type: null }` branch. So this migration touches every row, and the key recompute that
-- follows it must PRESERVE a NULL key rather than invent a type.
--
-- RESTARTABILITY. `prisma migrate deploy` wraps nothing in a transaction on any engine, measured
-- on all three, so a failure partway leaves the earlier statements committed. Every UPDATE below
-- is written `WHERE "currency" IS NULL` so re-running it is a no-op rather than a second pass.
--
-- WHY THIS LEG LOOKS DIFFERENT FROM THE OTHER TWO. SQLite cannot alter a column to NOT NULL, so
-- every affected table is rebuilt: new table, copy, drop, rename. The stamp is therefore not a
-- separate UPDATE but a literal in the copy's SELECT list ('EUR' and 2), which writes the value
-- into every row exactly as the UPDATE does elsewhere and for the same reason. No new table below
-- carries a DEFAULT on either column.
--
-- The rebuild is also why the widening is free here in a way it is not on the other two: SQLite's
-- INTEGER is already a variable-length integer up to 8 bytes, so BIGINT is the same storage and
-- the table would have been rebuilt for the new columns regardless.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "netWorthAccountId" TEXT,
    "bankConnectionId" TEXT,
    "providerAccountId" TEXT,
    "providerCashAccountType" TEXT,
    "nameKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Account_netWorthAccountId_fkey" FOREIGN KEY ("netWorthAccountId") REFERENCES "NetWorthAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Account_bankConnectionId_fkey" FOREIGN KEY ("bankConnectionId") REFERENCES "BankConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Account" ("bankConnectionId", "createdAt", "currency", "id", "name", "nameKey", "netWorthAccountId", "providerAccountId", "providerCashAccountType", "source", "updatedAt", "userId", "exponent") SELECT "bankConnectionId", "createdAt", "currency", "id", "name", "nameKey", "netWorthAccountId", "providerAccountId", "providerCashAccountType", "source", "updatedAt", "userId", 2 FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE INDEX "Account_userId_idx" ON "Account"("userId");
CREATE INDEX "Account_source_idx" ON "Account"("source");
CREATE INDEX "Account_userId_source_nameKey_idx" ON "Account"("userId", "source", "nameKey");
CREATE INDEX "Account_netWorthAccountId_idx" ON "Account"("netWorthAccountId");
CREATE INDEX "Account_bankConnectionId_idx" ON "Account"("bankConnectionId");
CREATE INDEX "Account_userId_source_providerAccountId_idx" ON "Account"("userId", "source", "providerAccountId");
CREATE UNIQUE INDEX "Account_userId_name_source_key" ON "Account"("userId", "name", "source");
CREATE TABLE "new_MonthlyBudget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "categoryNameKey" TEXT,
    "amountCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MonthlyBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MonthlyBudget" ("amountCents", "categoryName", "categoryNameKey", "createdAt", "id", "updatedAt", "userId", "currency", "exponent") SELECT "amountCents", "categoryName", "categoryNameKey", "createdAt", "id", "updatedAt", "userId", 'EUR', 2 FROM "MonthlyBudget";
DROP TABLE "MonthlyBudget";
ALTER TABLE "new_MonthlyBudget" RENAME TO "MonthlyBudget";
CREATE INDEX "MonthlyBudget_userId_idx" ON "MonthlyBudget"("userId");
CREATE UNIQUE INDEX "MonthlyBudget_userId_categoryNameKey_key" ON "MonthlyBudget"("userId", "categoryNameKey");
CREATE TABLE "new_NetWorthAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "balanceCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "deletedAt" DATETIME,
    "nameKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NetWorthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NetWorthAccount" ("balanceCents", "createdAt", "deletedAt", "id", "name", "nameKey", "type", "updatedAt", "userId", "currency", "exponent") SELECT "balanceCents", "createdAt", "deletedAt", "id", "name", "nameKey", "type", "updatedAt", "userId", 'EUR', 2 FROM "NetWorthAccount";
DROP TABLE "NetWorthAccount";
ALTER TABLE "new_NetWorthAccount" RENAME TO "NetWorthAccount";
CREATE INDEX "NetWorthAccount_userId_idx" ON "NetWorthAccount"("userId");
CREATE INDEX "NetWorthAccount_userId_deletedAt_idx" ON "NetWorthAccount"("userId", "deletedAt");
CREATE INDEX "NetWorthAccount_userId_nameKey_idx" ON "NetWorthAccount"("userId", "nameKey");
CREATE TABLE "new_NetWorthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "balanceCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetWorthSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "NetWorthAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NetWorthSnapshot" ("accountId", "balanceCents", "capturedAt", "id", "type", "userId", "currency", "exponent") SELECT "accountId", "balanceCents", "capturedAt", "id", "type", "userId", 'EUR', 2 FROM "NetWorthSnapshot";
DROP TABLE "NetWorthSnapshot";
ALTER TABLE "new_NetWorthSnapshot" RENAME TO "NetWorthSnapshot";
CREATE INDEX "NetWorthSnapshot_userId_capturedAt_idx" ON "NetWorthSnapshot"("userId", "capturedAt");
CREATE INDEX "NetWorthSnapshot_accountId_capturedAt_idx" ON "NetWorthSnapshot"("accountId", "capturedAt");
CREATE TABLE "new_SavingsGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmountCents" BIGINT NOT NULL,
    "netWorthAccountId" TEXT,
    "currentAmountCents" BIGINT NOT NULL DEFAULT 0,
    "startingBalanceCents" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "targetDate" DATETIME,
    "reachedAt" DATETIME,
    "reachedBannerDismissedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SavingsGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SavingsGoal_netWorthAccountId_fkey" FOREIGN KEY ("netWorthAccountId") REFERENCES "NetWorthAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SavingsGoal" ("createdAt", "currentAmountCents", "deletedAt", "id", "name", "netWorthAccountId", "reachedAt", "reachedBannerDismissedAt", "startingBalanceCents", "targetAmountCents", "targetDate", "updatedAt", "userId", "currency", "exponent") SELECT "createdAt", "currentAmountCents", "deletedAt", "id", "name", "netWorthAccountId", "reachedAt", "reachedBannerDismissedAt", "startingBalanceCents", "targetAmountCents", "targetDate", "updatedAt", "userId", 'EUR', 2 FROM "SavingsGoal";
DROP TABLE "SavingsGoal";
ALTER TABLE "new_SavingsGoal" RENAME TO "SavingsGoal";
CREATE INDEX "SavingsGoal_userId_idx" ON "SavingsGoal"("userId");
CREATE INDEX "SavingsGoal_userId_deletedAt_idx" ON "SavingsGoal"("userId", "deletedAt");
CREATE INDEX "SavingsGoal_netWorthAccountId_idx" ON "SavingsGoal"("netWorthAccountId");
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("accountId", "amountCents", "bankOperationType", "categoryId", "createdAt", "date", "dedupeKey", "dedupeKeyHash", "id", "importBatchId", "label", "manualCategory", "manualCategoryKey", "metadataJson", "natureManual", "notes", "source", "type", "updatedAt", "userId", "currency", "exponent") SELECT "accountId", "amountCents", "bankOperationType", "categoryId", "createdAt", "date", "dedupeKey", "dedupeKeyHash", "id", "importBatchId", "label", "manualCategory", "manualCategoryKey", "metadataJson", "natureManual", "notes", "source", "type", "updatedAt", "userId", 'EUR', 2 FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
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
CREATE TABLE "new_TransactionSplit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TransactionSplit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TransactionSplit_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TransactionSplit" ("amountCents", "categoryId", "createdAt", "id", "note", "position", "transactionId", "updatedAt") SELECT "amountCents", "categoryId", "createdAt", "id", "note", "position", "transactionId", "updatedAt" FROM "TransactionSplit";
DROP TABLE "TransactionSplit";
ALTER TABLE "new_TransactionSplit" RENAME TO "TransactionSplit";
CREATE INDEX "TransactionSplit_transactionId_idx" ON "TransactionSplit"("transactionId");
CREATE INDEX "TransactionSplit_categoryId_transactionId_idx" ON "TransactionSplit"("categoryId", "transactionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
