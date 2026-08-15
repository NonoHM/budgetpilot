-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "columnMappingId" TEXT;

-- CreateIndex
CREATE INDEX "ImportBatch_columnMappingId_idx" ON "ImportBatch"("columnMappingId");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_columnMappingId_fkey" FOREIGN KEY ("columnMappingId") REFERENCES "ColumnMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;
