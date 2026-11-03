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

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "transferPairId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_transferPairId_key" ON "Transaction"("transferPairId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_transferPairId_fkey" FOREIGN KEY ("transferPairId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

