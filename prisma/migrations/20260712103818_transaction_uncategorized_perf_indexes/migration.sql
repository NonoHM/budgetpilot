-- CreateIndex
CREATE INDEX "Transaction_userId_manualCategory_idx" ON "Transaction"("userId", "manualCategory");

-- CreateIndex
CREATE INDEX "Transaction_userId_categoryId_idx" ON "Transaction"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "Transaction_userId_natureManual_idx" ON "Transaction"("userId", "natureManual");
