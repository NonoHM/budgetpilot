-- When each session was last used, so a session unused for BP_SESSION_IDLE_TIMEOUT_HOURS ends (#221).
--
-- Every existing session is given the upgrade time, as ruled on #221: the upgrade signs nobody out,
-- and a session left unused since before it ends one idle timeout after it: at the first start,
-- `applySessionSettings` brings each `expiresAt` within the upgrade time plus the timeout.
--
-- SQLite cannot add a column whose default is CURRENT_TIMESTAMP, so the table is rebuilt with the
-- generalized procedure of https://www.sqlite.org/lang_altertable.html section 7, INSIDE ONE
-- TRANSACTION as that procedure says, because `prisma migrate deploy` wraps nothing in one. Foreign
-- keys are switched off around the transaction, as the procedure's steps 1 and 12 say (a PRAGMA
-- inside a transaction does nothing). No table references `Session`, so today this changes no row;
-- it keeps the procedure whole for whoever copies this file.
--
-- The backfill is written in the format the application writes, never with CURRENT_TIMESTAMP:
-- `@prisma/adapter-better-sqlite3` stores `2026-10-07T12:34:56.789+00:00` while CURRENT_TIMESTAMP
-- stores `2026-10-07 12:34:56` (measured 2026-10-07), and the two neither compare nor parse alike.
-- The column default is Prisma's own, so `prisma migrate diff` still matches; the application always
-- writes the value itself.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("createdAt", "expiresAt", "id", "lastSeenAt", "revokedAt", "tokenHash", "userId")
SELECT "createdAt", "expiresAt", "id", strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'), "revokedAt", "tokenHash", "userId" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
COMMIT;
PRAGMA foreign_keys=ON;
