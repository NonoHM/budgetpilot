PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Transaction" (
  "id" TEXT NOT NULL PRIMARY KEY,
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
  CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Transaction" (
  "id",
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

DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";

CREATE UNIQUE INDEX "Transaction_dedupeKey_key" ON "Transaction"("dedupeKey");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_source_idx" ON "Transaction"("source");
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");

CREATE TABLE "new_CategorizationRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "pattern" TEXT NOT NULL,
  "targetCategory" TEXT NOT NULL,
  "type" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_CategorizationRule" (
  "id",
  "pattern",
  "targetCategory",
  "type",
  "active",
  "createdAt",
  "updatedAt"
)
SELECT
  "id",
  "pattern",
  "targetCategory",
  "type",
  "active",
  "createdAt",
  "updatedAt"
FROM "CategorizationRule";

DROP TABLE "CategorizationRule";
ALTER TABLE "new_CategorizationRule" RENAME TO "CategorizationRule";

CREATE INDEX "CategorizationRule_active_idx" ON "CategorizationRule"("active");
CREATE INDEX "CategorizationRule_targetCategory_idx" ON "CategorizationRule"("targetCategory");

PRAGMA foreign_keys=ON;
