-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN "columnMappingId" TEXT REFERENCES "ColumnMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ImportBatch_columnMappingId_idx" ON "ImportBatch"("columnMappingId");
