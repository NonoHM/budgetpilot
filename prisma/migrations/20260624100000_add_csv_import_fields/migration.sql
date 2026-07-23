-- Add CSV import persistence fields.
ALTER TABLE "Transaction" ADD COLUMN "type" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "notes" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "dedupeKey" TEXT;

UPDATE "Transaction"
SET "type" = CASE
    WHEN "amountCents" >= 0 THEN 'income'
    ELSE 'expense'
END
WHERE "type" IS NULL;

CREATE UNIQUE INDEX "Transaction_dedupeKey_key" ON "Transaction"("dedupeKey");
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");
