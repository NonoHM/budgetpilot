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
-- WHAT A FAILURE PARTWAY LEAVES, MEASURED RATHER THAN REASONED. `prisma migrate deploy` wraps
-- nothing in a transaction on ANY engine, PostgreSQL included. Measured here on PostgreSQL 17.10
-- by the documented method: a poison statement raising a UNIQUE violation (never a reference to a
-- missing table, which could be raised while preparing the script and would look identical to a
-- rollback) placed after the Transaction block. Result: `Transaction` kept both new columns and its
-- widened `amountCents`, `SavingsGoal` had neither, and `_prisma_migrations` recorded
-- `finished_at` NULL, `rolled_back_at` NULL, `applied_steps_count` 0.
--
-- THIS MIGRATION IS NOT RESTARTABLE, and the first draft of this comment claimed it was. MEASURED:
-- `migrate resolve --rolled-back` followed by `migrate deploy` fails with PostgreSQL 42701,
-- "column already exists", because ADD COLUMN is not idempotent on any of the three engines and
-- SQLite's leg is a table rebuild whose CREATE TABLE is not either. Recovery is by hand, from the
-- statement that failed onward.
--
-- What the `WHERE "currency" IS NULL` on every UPDATE actually buys is that hand recovery: an
-- operator running the remaining statements cannot double-stamp, and can re-run an UPDATE safely
-- while working out where the failure landed. It does not make the file re-runnable, and saying so
-- would be worse than saying nothing.
--
-- Statement counts, so the blast radius of a failure is a number rather than a feeling: 63 on
-- SQLite (a table rebuild per affected table), 37 on PostgreSQL, 27 on MySQL and MariaDB.

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
-- A transaction is denominated by the bucket it belongs to, and `Account.currency` has been
-- writable to a non-euro value since bank sync existed: `banking/connectors/enablebanking.ts`
-- stores whatever the provider names. Stamping every transaction 'EUR' would make those rows
-- positively assert something false, where before this migration they asserted nothing. The
-- account's own value is the only better answer that exists, and it exists, so it is used.
--
-- The EXPONENT cannot be better than 2 and this is the honest limit of the migration: no
-- pre-existing row records one, and no list is consulted (see the design note). Every currency
-- BudgetPilot has actually seen has two decimals, so 2 is right for them; a pre-change account in
-- one of the seven 3-decimal currencies is the one case this migration cannot recover, and it
-- could not be recovered by any other means either, because the information was never stored.
UPDATE `Transaction` t JOIN `Account` a ON a.`id` = t.`accountId`
   SET t.`currency` = a.`currency`, t.`exponent` = 2
 WHERE t.`currency` IS NULL;
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
