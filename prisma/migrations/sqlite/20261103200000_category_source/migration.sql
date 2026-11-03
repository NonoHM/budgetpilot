-- Who set a transaction's manual category (#1013): two nullable columns on Transaction, the author
-- (member, rule, or a member accepting a suggestion) and the `manualCategoryKey` it was written
-- for. Read only through `categorySetBy` (src/lib/domain/categorySetBy.ts).
--
-- Additive: no existing row changes and no value is stamped, so every pin written before this
-- migration reads unknown and is never learned from, which is the issue's requirement and not a
-- shortcut. A version older than 1.4 keeps running on this schema; what it writes in the meantime
-- is covered by the key check and by `scripts/reset-category-authors.mjs` (docs/operations.md).
-- Prisma's statements, unchanged, so `prisma migrate diff` still matches. `migrate deploy` wraps
-- nothing in a transaction: a failure between statements leaves the migration marked failed and
-- the boot refuses to start; no stored figure is damaged. Recovery is by hand from the statement
-- that failed onward.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "manualCategorySource" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "manualCategorySourceKey" TEXT;
