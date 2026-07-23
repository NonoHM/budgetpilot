ALTER TABLE "Transaction" ADD COLUMN "budgetImpact" TEXT NOT NULL DEFAULT 'included';

CREATE INDEX "Transaction_budgetImpact_idx" ON "Transaction"("budgetImpact");
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");

ALTER TABLE "ImportBatch" ADD COLUMN "profile" TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE "ImportBatch" ADD COLUMN "importedRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "duplicateRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "invalidRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "periodStart" DATETIME;
ALTER TABLE "ImportBatch" ADD COLUMN "periodEnd" DATETIME;
ALTER TABLE "ImportBatch" ADD COLUMN "updatedAt" DATETIME;

UPDATE "ImportBatch"
SET "updatedAt" = COALESCE("createdAt", CURRENT_TIMESTAMP)
WHERE "updatedAt" IS NULL;

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ImportBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
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
  "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_ImportBatch" (
  "id",
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

DROP TABLE "ImportBatch";
ALTER TABLE "new_ImportBatch" RENAME TO "ImportBatch";

PRAGMA foreign_keys=ON;

CREATE INDEX "ImportBatch_source_idx" ON "ImportBatch"("source");
CREATE INDEX "ImportBatch_createdAt_idx" ON "ImportBatch"("createdAt");

CREATE TABLE "CategorizationRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "pattern" TEXT NOT NULL,
  "targetCategory" TEXT NOT NULL,
  "type" TEXT,
  "budgetImpact" TEXT NOT NULL DEFAULT 'included',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "CategorizationRule_active_idx" ON "CategorizationRule"("active");
CREATE INDEX "CategorizationRule_targetCategory_idx" ON "CategorizationRule"("targetCategory");
