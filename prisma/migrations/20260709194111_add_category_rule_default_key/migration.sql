-- AlterTable
ALTER TABLE "CategoryRule" ADD COLUMN "defaultRuleKey" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "defaultRulesSeededAt" DATETIME;
