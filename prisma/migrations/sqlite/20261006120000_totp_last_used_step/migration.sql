-- The time step of the last TOTP code accepted for a user, so a code is accepted once (#818).
--
-- NULL on every existing row: no code has been accepted under the new rule yet, so the first code
-- after the upgrade is judged against nothing, as a code was before it. Nullable with no default and
-- no backfill, so the column cannot hold a value no acceptance wrote.
--
-- ONE STATEMENT, because `prisma migrate deploy` wraps nothing in a transaction on any engine.
ALTER TABLE "User" ADD COLUMN "totpLastUsedStep" INTEGER;
