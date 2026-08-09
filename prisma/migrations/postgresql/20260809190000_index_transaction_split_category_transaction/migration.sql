-- Makes the `?category=` filter's part branch use a COVERING index instead of scanning every
-- part in the category once per candidate transaction. Measured on a 10 000-transaction fixture
-- with 2 000 parts under one category: /transactions?category=Loisirs went from 8 366 ms to
-- 60 ms. See the comment on @@index([categoryId, transactionId]) in prisma/schema.prisma.
--
-- Created BEFORE the old index is dropped, so `categoryId` is never left without a leading index
-- (MySQL refuses to drop the last index serving a foreign key; the other two engines do not care,
-- and the three histories are kept in the same order so they read alike).

-- CreateIndex
CREATE INDEX "TransactionSplit_categoryId_transactionId_idx" ON "TransactionSplit"("categoryId", "transactionId");

-- DropIndex
DROP INDEX "TransactionSplit_categoryId_idx";
