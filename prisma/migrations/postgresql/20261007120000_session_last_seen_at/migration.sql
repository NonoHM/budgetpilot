-- When each session was last used, so a session unused for BP_SESSION_IDLE_TIMEOUT_HOURS ends (#221).
--
-- Every existing session is given the upgrade time, as ruled on #221: the upgrade signs nobody out,
-- and a session left unused since before it ends one idle timeout after it: at the first start,
-- `applySessionSettings` brings each `expiresAt` within the upgrade time plus the timeout.
--
-- The time zone is pinned to UTC for this transaction because `CURRENT_TIMESTAMP` written into a
-- `TIMESTAMP` column is the server's LOCAL time, while the application writes and reads UTC: on a
-- server set to America/New_York the backfill was measured four hours behind (2026-10-07). The
-- ALTER is Prisma's own, unchanged, so `prisma migrate diff` still matches the schema.
--
-- One transaction, because `prisma migrate deploy` wraps nothing in one on any engine, and
-- PostgreSQL runs DDL inside a transaction.
BEGIN;
SET LOCAL TIME ZONE 'UTC';
ALTER TABLE "Session" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
COMMIT;
