/*
  Warnings:

  - Added the required column `tokenHash` to the `PendingMfaChallenge` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PendingMfaChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingMfaChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PendingMfaChallenge" ("createdAt", "expiresAt", "id", "userId") SELECT "createdAt", "expiresAt", "id", "userId" FROM "PendingMfaChallenge";
DROP TABLE "PendingMfaChallenge";
ALTER TABLE "new_PendingMfaChallenge" RENAME TO "PendingMfaChallenge";
CREATE UNIQUE INDEX "PendingMfaChallenge_tokenHash_key" ON "PendingMfaChallenge"("tokenHash");
CREATE INDEX "PendingMfaChallenge_userId_idx" ON "PendingMfaChallenge"("userId");
CREATE INDEX "PendingMfaChallenge_expiresAt_idx" ON "PendingMfaChallenge"("expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
