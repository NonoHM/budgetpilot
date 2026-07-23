/*
  Warnings:

  - You are about to drop the column `emailKey` on the `LoginAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `ipKey` on the `LoginAttempt` table. All the data in the column will be lost.
  - Added the required column `emailHash` to the `LoginAttempt` table without a default value. This is not possible if the table is not empty.
  - Added the required column `ipHash` to the `LoginAttempt` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LoginAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emailHash" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_LoginAttempt" ("createdAt", "id") SELECT "createdAt", "id" FROM "LoginAttempt";
DROP TABLE "LoginAttempt";
ALTER TABLE "new_LoginAttempt" RENAME TO "LoginAttempt";
CREATE INDEX "LoginAttempt_emailHash_createdAt_idx" ON "LoginAttempt"("emailHash", "createdAt");
CREATE INDEX "LoginAttempt_ipHash_createdAt_idx" ON "LoginAttempt"("ipHash", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
