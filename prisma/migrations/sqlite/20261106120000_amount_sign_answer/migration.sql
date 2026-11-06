-- The member's answer for an amount column with no minus sign, and the account it was given for
-- (#1294): two nullable columns on ColumnMapping. Written only by the server (`saveColumnMapping`,
-- from the answer the parse applied) and by the backup restore, never posted as a stored value.
--
-- Additive: no existing row changes and no value is stamped, so every mapping written before this
-- migration holds no answer and an unsigned statement is asked as before. Prisma's statements,
-- unchanged, so `prisma migrate diff` still matches. `migrate deploy` wraps nothing in a
-- transaction: a failure between statements leaves the migration marked failed and the boot refuses
-- to start; no stored figure is damaged. Recovery is by hand from the statement that failed onward.

-- AlterTable
ALTER TABLE "ColumnMapping" ADD COLUMN "amountSign" TEXT;
ALTER TABLE "ColumnMapping" ADD COLUMN "amountSignAccountId" TEXT;
