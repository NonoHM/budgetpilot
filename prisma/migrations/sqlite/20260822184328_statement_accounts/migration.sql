-- AlterTable
ALTER TABLE "Account" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "Account" ADD COLUMN "discriminant" TEXT;
ALTER TABLE "Account" ADD COLUMN "institution" TEXT;

-- CreateTable
CREATE TABLE "ImportSourceSignature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "discriminant" TEXT,
    "accountId" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportSourceSignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImportSourceSignature_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    -- NULLABLE HERE, REQUIRED IN THE DATAMODEL, AND THE DIVERGENCE IS DELIBERATE.
    -- This table already holds rows on every existing install and the copy below has no value to
    -- give them, so NOT NULL would abort the upgrade. No DEFAULT either: a default would file
    -- every legacy batch into one invented account and nothing would ever report it. The backfill
    -- reads each batch's own transactions; the NOT NULL tightening is a later migration, once
    -- every row carries one.
    "accountId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'csv',
    "fileName" TEXT,
    "profile" TEXT NOT NULL DEFAULT 'generic',
    "rowCount" INTEGER NOT NULL,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "columnMappingId" TEXT,
    "dateOrder" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImportBatch_columnMappingId_fkey" FOREIGN KEY ("columnMappingId") REFERENCES "ColumnMapping" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ImportBatch" ("columnMappingId", "createdAt", "duplicateRows", "fileName", "id", "importedRows", "invalidRows", "periodEnd", "periodStart", "profile", "rowCount", "source", "updatedAt", "userId") SELECT "columnMappingId", "createdAt", "duplicateRows", "fileName", "id", "importedRows", "invalidRows", "periodEnd", "periodStart", "profile", "rowCount", "source", "updatedAt", "userId" FROM "ImportBatch";
DROP TABLE "ImportBatch";
ALTER TABLE "new_ImportBatch" RENAME TO "ImportBatch";
CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");
CREATE INDEX "ImportBatch_source_idx" ON "ImportBatch"("source");
CREATE INDEX "ImportBatch_userId_createdAt_idx" ON "ImportBatch"("userId", "createdAt");
CREATE INDEX "ImportBatch_columnMappingId_idx" ON "ImportBatch"("columnMappingId");
CREATE INDEX "ImportBatch_accountId_idx" ON "ImportBatch"("accountId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ImportSourceSignature_userId_idx" ON "ImportSourceSignature"("userId");

-- CreateIndex
CREATE INDEX "ImportSourceSignature_accountId_idx" ON "ImportSourceSignature"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportSourceSignature_userId_fingerprint_discriminant_key" ON "ImportSourceSignature"("userId", "fingerprint", "discriminant");

-- CreateIndex
CREATE INDEX "Account_userId_archivedAt_idx" ON "Account"("userId", "archivedAt");
