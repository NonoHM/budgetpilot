-- DropIndex
DROP INDEX "Category_userId_nameKey_idx";

-- DropIndex
DROP INDEX "Category_userId_name_key";

-- DropIndex
DROP INDEX "CategoryNatureMapping_userId_categoryNameKey_idx";

-- DropIndex
DROP INDEX "CategoryNatureMapping_userId_categoryName_key";

-- DropIndex
DROP INDEX "MonthlyBudget_userId_categoryNameKey_idx";

-- DropIndex
DROP INDEX "MonthlyBudget_userId_categoryName_key";

-- DropIndex
DROP INDEX "Transaction_userId_dedupeKeyHash_idx";

-- DropIndex
DROP INDEX "Transaction_userId_dedupeKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_nameKey_key" ON "Category"("userId", "nameKey");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryNatureMapping_userId_categoryNameKey_key" ON "CategoryNatureMapping"("userId", "categoryNameKey");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyBudget_userId_categoryNameKey_key" ON "MonthlyBudget"("userId", "categoryNameKey");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_userId_dedupeKeyHash_key" ON "Transaction"("userId", "dedupeKeyHash");

