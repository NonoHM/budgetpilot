-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LoginAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emailHash" TEXT,
    "ipHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'LOGIN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_LoginAttempt" ("createdAt", "emailHash", "id", "ipHash") SELECT "createdAt", "emailHash", "id", "ipHash" FROM "LoginAttempt";
DROP TABLE "LoginAttempt";
ALTER TABLE "new_LoginAttempt" RENAME TO "LoginAttempt";
CREATE INDEX "LoginAttempt_emailHash_createdAt_idx" ON "LoginAttempt"("emailHash", "createdAt");
CREATE INDEX "LoginAttempt_ipHash_createdAt_idx" ON "LoginAttempt"("ipHash", "createdAt");
CREATE INDEX "LoginAttempt_ipHash_kind_createdAt_idx" ON "LoginAttempt"("ipHash", "kind", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
