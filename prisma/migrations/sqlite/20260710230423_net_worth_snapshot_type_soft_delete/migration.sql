-- Soft delete on NetWorthAccount: keeps historical snapshots alive after "deletion".
ALTER TABLE "NetWorthAccount" ADD COLUMN "deletedAt" DATETIME;

-- Uniqueness of (userId, name) is now enforced in application code against active
-- (non-deleted) accounts only, so a deleted account's name can be reused.
DROP INDEX "NetWorthAccount_userId_name_key";

-- CreateIndex
CREATE INDEX "NetWorthAccount_userId_deletedAt_idx" ON "NetWorthAccount"("userId", "deletedAt");

-- NetWorthSnapshot.type: frozen per point so a later change to the account's type never
-- retroactively flips the sign of past points on the curve. Backfilled from the account's
-- current type (best-effort for pre-existing rows: the bug this fixes wasn't tracked before).
ALTER TABLE "NetWorthSnapshot" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'checking';

UPDATE "NetWorthSnapshot"
SET "type" = (
  SELECT "NetWorthAccount"."type"
  FROM "NetWorthAccount"
  WHERE "NetWorthAccount"."id" = "NetWorthSnapshot"."accountId"
);
