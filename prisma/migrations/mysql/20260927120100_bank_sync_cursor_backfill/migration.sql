-- Seeds the fetch cursor (#763) from `lastSyncAt`, ONLY where the last sync succeeded.
--
-- There, `lastSyncAt` is the instant of a sync that completed, which is what the cursor means, and
-- the next sync asks the bank for the same window it would have asked for before this change.
--
-- Everywhere else the cursor stays NULL on purpose. After a failure, `lastSyncAt` holds the failed
-- attempt, which is exactly the value that skipped days; copying it would store the defect in the
-- new column. NULL makes the next sync fetch the whole first-sync lookback, which is also the
-- repair for a connection the defect already reached: the days it skipped come back as far as the
-- lookback reaches, and deduplication absorbs the rows already present.
--
-- NOT repaired, because nothing records where it lies: a gap left by a failure that a later
-- SUCCESSFUL sync followed. That success moved `lastSyncAt` on and set the status back to 'ok'.
--
-- One statement, for the reason in the previous migration. Re-runnable: it only fills a NULL.
UPDATE `BankConnection`
SET `lastCompleteSyncAt` = `lastSyncAt`
WHERE `lastSyncStatus` = 'ok' AND `lastCompleteSyncAt` IS NULL;
