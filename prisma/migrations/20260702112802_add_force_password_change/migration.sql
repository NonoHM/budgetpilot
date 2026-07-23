-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "forcePasswordChange" BOOLEAN NOT NULL DEFAULT false,
    "defaultsSeededAt" DATETIME,
    "aiInsightsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiIncludeLabels" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("aiIncludeLabels", "aiInsightsEnabled", "createdAt", "defaultsSeededAt", "email", "id", "passwordHash", "role", "updatedAt") SELECT "aiIncludeLabels", "aiInsightsEnabled", "createdAt", "defaultsSeededAt", "email", "id", "passwordHash", "role", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
