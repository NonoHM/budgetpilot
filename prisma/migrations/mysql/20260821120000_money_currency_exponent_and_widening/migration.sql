-- Every stored amount carries its own currency and its own exponent, and every money column is
-- 64-bit.
--
-- WHY THE PAIR IS A PAIR. A row written under a non-euro currency with no exponent beside it is
-- ambiguous forever: 1000 under JOD is either 10.00 or 1.000, and no later migration can decide
-- which, because the information was never stored. That is the one thing about multi-currency
-- that turns existing rows into a 2.0, so currency and exponent arrive together or not at all.
-- The exponent is STORED rather than derived from the code, for one reason that no other reason
-- supports: a code withdrawn from ISO 4217 has no published exponent anywhere, so a row whose
-- meaning depended on a list would stop being readable the moment the list moved.
--
-- WHY THE COLUMNS ARE WIDENED IN THE SAME CHANGE. `domain/netWorth.ts` caps net worth at
-- 1,000,000,000 minor units. At exponent 3 that is 10,000,000,000, about five times a signed
-- 32-bit column, so supporting the seven 3-decimal currencies means widening or silently
-- refusing the app's own stated cap for them. Value-preserving, therefore not breaking; expensive
-- on a grown table, therefore done now.
--
-- WHY THERE IS NO COLUMN DEFAULT, AND WHY THE STAMP IS AN EXPLICIT UPDATE. The shortcut is
-- `ADD COLUMN "exponent" INTEGER NOT NULL DEFAULT 2`, one statement instead of three. On
-- PostgreSQL it is exactly what this design refuses: MEASURED on 17.10, that leaves
-- `pg_attribute.atthasmissing` true with `attmissingval = {2}` and REWRITES NO ROW, so the value
-- is synthesised on read from the catalogue and there is nothing in any row to correct. The
-- three-step below leaves `atthasmissing` false, which is the observable difference. A row whose
-- exponent is corrected later would otherwise have a deduplication key describing a different
-- amount than the one stored: a default is a value with no author, and this is the class of
-- column where that is fatal rather than untidy. No default survives this migration, so a future
-- write path that forgets a denomination fails loudly instead of silently becoming euros.
--
-- WHY EVERY ROW IS STAMPED REGARDLESS OF `Transaction.type`. `type` is nullable and stays
-- nullable. A NULL-type row cannot be keyed, so it gets a NULL deduplication key and stays
-- invisible to deduplication, which is the existing behaviour for manual transactions rather than
-- a new rule. COUNTED on the one real install available: zero such rows. That says the state has
-- not OCCURRED there, not that it cannot. READ, and this is the half a count cannot give you:
-- server/backup/schema.ts declares `type` nullable in the backup contract and
-- server/backup/import.ts writes it verbatim, so restore is a production path that can write one
-- and 1.0 freezes that contract; server/transactions/totals.ts already carries a production
-- `{ type: null }` branch. So this migration touches every row, and the key recompute that
-- follows it must PRESERVE a NULL key rather than invent a type.
--
-- RESTARTABILITY. `prisma migrate deploy` wraps nothing in a transaction on any engine, measured
-- on all three, so a failure partway leaves the earlier statements committed. Every UPDATE below
-- is written `WHERE "currency" IS NULL` so re-running it is a no-op rather than a second pass.

-- 1. Widen the eight money columns. `MODIFY` restates the column, so the DEFAULT and NOT NULL of
--    the two SavingsGoal columns that have one are restated too: dropping them here would be a
--    silent schema change that `migrate diff` would then report as drift.
ALTER TABLE `TransactionSplit` MODIFY `amountCents` BIGINT NOT NULL;
ALTER TABLE `Transaction` MODIFY `amountCents` BIGINT NOT NULL;
ALTER TABLE `MonthlyBudget` MODIFY `amountCents` BIGINT NOT NULL;
ALTER TABLE `NetWorthAccount` MODIFY `balanceCents` BIGINT NOT NULL;
ALTER TABLE `NetWorthSnapshot` MODIFY `balanceCents` BIGINT NOT NULL;
ALTER TABLE `SavingsGoal` MODIFY `targetAmountCents` BIGINT NOT NULL;
ALTER TABLE `SavingsGoal` MODIFY `currentAmountCents` BIGINT NOT NULL DEFAULT 0;
ALTER TABLE `SavingsGoal` MODIFY `startingBalanceCents` BIGINT NOT NULL DEFAULT 0;

-- 2. Account already carries a currency. It gains the exponent that makes it a pair, and loses the
--    default that made its currency authorless.
ALTER TABLE `Account` ADD COLUMN `exponent` INTEGER NULL;
UPDATE `Account` SET `exponent` = 2 WHERE `exponent` IS NULL;
ALTER TABLE `Account` MODIFY `exponent` INTEGER NOT NULL;
ALTER TABLE `Account` ALTER COLUMN `currency` DROP DEFAULT;

-- 3. The five models that own an amount. TransactionSplit deliberately gets neither: a part is
--    denominated by its parent, and a second currency is what would let the conservation rule
--    `sum(parts) = parent.amountCents` become false.
ALTER TABLE `Transaction` ADD COLUMN `currency` VARCHAR(191) NULL, ADD COLUMN `exponent` INTEGER NULL;
UPDATE `Transaction` SET `currency` = 'EUR', `exponent` = 2 WHERE `currency` IS NULL;
ALTER TABLE `Transaction` MODIFY `currency` VARCHAR(191) NOT NULL, MODIFY `exponent` INTEGER NOT NULL;

ALTER TABLE `MonthlyBudget` ADD COLUMN `currency` VARCHAR(191) NULL, ADD COLUMN `exponent` INTEGER NULL;
UPDATE `MonthlyBudget` SET `currency` = 'EUR', `exponent` = 2 WHERE `currency` IS NULL;
ALTER TABLE `MonthlyBudget` MODIFY `currency` VARCHAR(191) NOT NULL, MODIFY `exponent` INTEGER NOT NULL;

ALTER TABLE `NetWorthAccount` ADD COLUMN `currency` VARCHAR(191) NULL, ADD COLUMN `exponent` INTEGER NULL;
UPDATE `NetWorthAccount` SET `currency` = 'EUR', `exponent` = 2 WHERE `currency` IS NULL;
ALTER TABLE `NetWorthAccount` MODIFY `currency` VARCHAR(191) NOT NULL, MODIFY `exponent` INTEGER NOT NULL;

ALTER TABLE `NetWorthSnapshot` ADD COLUMN `currency` VARCHAR(191) NULL, ADD COLUMN `exponent` INTEGER NULL;
UPDATE `NetWorthSnapshot` SET `currency` = 'EUR', `exponent` = 2 WHERE `currency` IS NULL;
ALTER TABLE `NetWorthSnapshot` MODIFY `currency` VARCHAR(191) NOT NULL, MODIFY `exponent` INTEGER NOT NULL;

ALTER TABLE `SavingsGoal` ADD COLUMN `currency` VARCHAR(191) NULL, ADD COLUMN `exponent` INTEGER NULL;
UPDATE `SavingsGoal` SET `currency` = 'EUR', `exponent` = 2 WHERE `currency` IS NULL;
ALTER TABLE `SavingsGoal` MODIFY `currency` VARCHAR(191) NOT NULL, MODIFY `exponent` INTEGER NOT NULL;
