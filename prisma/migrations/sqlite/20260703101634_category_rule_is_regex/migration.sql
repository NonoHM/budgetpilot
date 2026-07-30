-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CategoryRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matchText" TEXT NOT NULL,
    "targetCategory" TEXT NOT NULL,
    "targetNature" TEXT,
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CategoryRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CategoryRule" ("createdAt", "enabled", "id", "matchText", "name", "targetCategory", "targetNature", "updatedAt", "userId") SELECT "createdAt", "enabled", "id", "matchText", "name", "targetCategory", "targetNature", "updatedAt", "userId" FROM "CategoryRule";
DROP TABLE "CategoryRule";
ALTER TABLE "new_CategoryRule" RENAME TO "CategoryRule";
CREATE INDEX "CategoryRule_userId_idx" ON "CategoryRule"("userId");
CREATE INDEX "CategoryRule_userId_enabled_idx" ON "CategoryRule"("userId", "enabled");
CREATE INDEX "CategoryRule_userId_targetCategory_idx" ON "CategoryRule"("userId", "targetCategory");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
