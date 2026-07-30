-- AlterTable
ALTER TABLE "Account" ADD COLUMN "nameKey" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN "nameKey" TEXT;

-- AlterTable
ALTER TABLE "CategoryNatureMapping" ADD COLUMN "categoryNameKey" TEXT;

-- AlterTable
ALTER TABLE "MonthlyBudget" ADD COLUMN "categoryNameKey" TEXT;

-- AlterTable
ALTER TABLE "NetWorthAccount" ADD COLUMN "nameKey" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "manualCategoryKey" TEXT;

-- CreateIndex
CREATE INDEX "Account_userId_source_nameKey_idx" ON "Account"("userId", "source", "nameKey");

-- CreateIndex
CREATE INDEX "Category_userId_nameKey_idx" ON "Category"("userId", "nameKey");

-- CreateIndex
CREATE INDEX "CategoryNatureMapping_userId_categoryNameKey_idx" ON "CategoryNatureMapping"("userId", "categoryNameKey");

-- CreateIndex
CREATE INDEX "MonthlyBudget_userId_categoryNameKey_idx" ON "MonthlyBudget"("userId", "categoryNameKey");

-- CreateIndex
CREATE INDEX "NetWorthAccount_userId_nameKey_idx" ON "NetWorthAccount"("userId", "nameKey");

-- CreateIndex
CREATE INDEX "Transaction_userId_manualCategoryKey_idx" ON "Transaction"("userId", "manualCategoryKey");
