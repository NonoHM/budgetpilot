-- When each session was last used, so a session unused for BP_SESSION_IDLE_TIMEOUT_HOURS ends (#221).
--
-- Every existing session is given the upgrade time, as ruled on #221: the upgrade signs nobody out,
-- and a session left unused since before it ends one idle timeout after it: at the first start,
-- `applySessionSettings` brings each `expiresAt` within the upgrade time plus the timeout.
--
-- The time zone is set to UTC for this connection because `CURRENT_TIMESTAMP(3)` written into a
-- `DATETIME` column is the session's LOCAL time, while the application writes and reads UTC: on a
-- server started with --default-time-zone=-05:00 the backfill was measured five hours behind
-- (2026-10-07). The ALTER is Prisma's own, unchanged, so `prisma migrate diff` still matches.
--
-- ONE STATEMENT writes data, because MariaDB commits every DDL statement on its own. `prisma migrate
-- deploy` runs every pending migration on ONE connection, so the connection's own zone is saved and
-- put back afterwards: a later migration in the same run reads the clock as it would in a run of
-- its own, including on a server whose `init_connect` sets a zone of its own.
SET @bp_time_zone_before = @@session.time_zone;
SET time_zone = '+00:00';
ALTER TABLE `Session` ADD COLUMN `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
SET time_zone = @bp_time_zone_before;
