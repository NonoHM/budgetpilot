-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "dedupeKeyHash" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_userId_dedupeKeyHash_idx" ON "Transaction"("userId", "dedupeKeyHash");
