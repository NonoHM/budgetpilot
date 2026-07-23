-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "User" ("id", "email", "passwordHash", "role", "createdAt", "updatedAt")
VALUES (
    'local-backfill-user',
    'local-backfill@budgetpilot.local',
    'BACKFILL_LOGIN_DISABLED',
    'ADMIN',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Account" ("id", "userId", "name", "currency", "source", "createdAt", "updatedAt")
SELECT "id", 'local-backfill-user', "name", "currency", "source", "createdAt", "updatedAt"
FROM "Account";

CREATE TABLE "new_Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Category" ("id", "userId", "name", "createdAt", "updatedAt")
SELECT "id", 'local-backfill-user', "name", "createdAt", "updatedAt"
FROM "Category";

CREATE TABLE "new_ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'csv',
    "fileName" TEXT,
    "profile" TEXT NOT NULL DEFAULT 'generic',
    "rowCount" INTEGER NOT NULL,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ImportBatch" (
    "id",
    "userId",
    "source",
    "fileName",
    "profile",
    "rowCount",
    "importedRows",
    "duplicateRows",
    "invalidRows",
    "periodStart",
    "periodEnd",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    'local-backfill-user',
    "source",
    "fileName",
    "profile",
    "rowCount",
    "importedRows",
    "duplicateRows",
    "invalidRows",
    "periodStart",
    "periodEnd",
    "createdAt",
    "updatedAt"
FROM "ImportBatch";

CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "date" DATETIME NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "type" TEXT,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "dedupeKey" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Transaction" (
    "id",
    "userId",
    "accountId",
    "categoryId",
    "importBatchId",
    "date",
    "label",
    "amountCents",
    "type",
    "source",
    "notes",
    "dedupeKey",
    "metadataJson",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    'local-backfill-user',
    "accountId",
    "categoryId",
    "importBatchId",
    "date",
    "label",
    "amountCents",
    "type",
    "source",
    "notes",
    "dedupeKey",
    "metadataJson",
    "createdAt",
    "updatedAt"
FROM "Transaction";

CREATE TABLE "new_Budget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Budget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Budget" ("id", "userId", "categoryId", "month", "limitCents", "createdAt", "updatedAt")
SELECT "id", 'local-backfill-user', "categoryId", "month", "limitCents", "createdAt", "updatedAt"
FROM "Budget";

CREATE TABLE "new_CategorizationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "targetCategory" TEXT NOT NULL,
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CategorizationRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_CategorizationRule" (
    "id",
    "userId",
    "pattern",
    "targetCategory",
    "type",
    "active",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    'local-backfill-user',
    "pattern",
    "targetCategory",
    "type",
    "active",
    "createdAt",
    "updatedAt"
FROM "CategorizationRule";

DROP TABLE "Transaction";
DROP TABLE "Budget";
DROP TABLE "Account";
DROP TABLE "Category";
DROP TABLE "ImportBatch";
DROP TABLE "CategorizationRule";

ALTER TABLE "new_Account" RENAME TO "Account";
ALTER TABLE "new_Category" RENAME TO "Category";
ALTER TABLE "new_ImportBatch" RENAME TO "ImportBatch";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
ALTER TABLE "new_Budget" RENAME TO "Budget";
ALTER TABLE "new_CategorizationRule" RENAME TO "CategorizationRule";

PRAGMA foreign_keys=ON;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

CREATE UNIQUE INDEX "Account_userId_name_source_key" ON "Account"("userId", "name", "source");
CREATE INDEX "Account_userId_idx" ON "Account"("userId");
CREATE INDEX "Account_source_idx" ON "Account"("source");

CREATE UNIQUE INDEX "Category_userId_name_key" ON "Category"("userId", "name");
CREATE INDEX "Category_userId_idx" ON "Category"("userId");

CREATE UNIQUE INDEX "Transaction_userId_dedupeKey_key" ON "Transaction"("userId", "dedupeKey");
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_source_idx" ON "Transaction"("source");
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");
CREATE INDEX "Transaction_userId_date_idx" ON "Transaction"("userId", "date");
CREATE INDEX "Transaction_userId_accountId_date_idx" ON "Transaction"("userId", "accountId", "date");

CREATE UNIQUE INDEX "Budget_userId_categoryId_month_key" ON "Budget"("userId", "categoryId", "month");
CREATE INDEX "Budget_userId_idx" ON "Budget"("userId");
CREATE INDEX "Budget_userId_month_idx" ON "Budget"("userId", "month");

CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");
CREATE INDEX "ImportBatch_source_idx" ON "ImportBatch"("source");
CREATE INDEX "ImportBatch_userId_createdAt_idx" ON "ImportBatch"("userId", "createdAt");

CREATE INDEX "CategorizationRule_userId_idx" ON "CategorizationRule"("userId");
CREATE INDEX "CategorizationRule_userId_active_idx" ON "CategorizationRule"("userId", "active");
CREATE INDEX "CategorizationRule_userId_targetCategory_idx" ON "CategorizationRule"("userId", "targetCategory");
