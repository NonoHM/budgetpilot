-- Makes the `?category=` filter's part branch use a COVERING index instead of scanning every
-- part in the category once per candidate transaction. Measured on a 10 000-transaction fixture
-- with 2 000 parts under one category: /transactions?category=Loisirs went from 8 366 ms to
-- 60 ms. See the comment on @@index([categoryId, transactionId]) in prisma/schema.prisma.
--
-- Created BEFORE the old index is dropped, and on this engine that order is load-bearing rather
-- than cosmetic: `TransactionSplit_categoryId_fkey` needs an index whose leading column is
-- `categoryId`, and MySQL/MariaDB refuse to drop the last one that serves a foreign key. The
-- composite index takes over that duty the moment it exists.

-- CreateIndex
CREATE INDEX `TransactionSplit_categoryId_transactionId_idx` ON `TransactionSplit`(`categoryId`, `transactionId`);

-- DropIndex
DROP INDEX `TransactionSplit_categoryId_idx` ON `TransactionSplit`;
