-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "TransactionNature" AS ENUM ('income', 'spending', 'transfer', 'investment', 'refund', 'fee', 'uncategorized');

-- CreateEnum
CREATE TYPE "NetWorthAccountType" AS ENUM ('checking', 'savings', 'investment', 'debt', 'real_estate', 'other');

-- CreateEnum
CREATE TYPE "BankConnectionStatus" AS ENUM ('active', 'expired', 'revoked', 'error');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "forcePasswordChange" BOOLEAN NOT NULL DEFAULT false,
    "defaultsSeededAt" TIMESTAMP(3),
    "defaultRulesSeededAt" TIMESTAMP(3),
    "aiInsightsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiIncludeLabels" BOOLEAN NOT NULL DEFAULT false,
    "totpSecretEncrypted" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpEnabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingMfaChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingMfaChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT,
    "createdByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "netWorthAccountId" TEXT,
    "bankConnectionId" TEXT,
    "providerAccountId" TEXT,
    "providerCashAccountType" TEXT,
    "nameKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "credentialsEncrypted" TEXT,
    "status" "BankConnectionStatus" NOT NULL DEFAULT 'active',
    "aspspName" TEXT,
    "aspspCountry" TEXT,
    "consentExpiresAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAuthorizationRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "stateEncrypted" TEXT NOT NULL,
    "aspspName" TEXT NOT NULL,
    "aspspCountry" TEXT NOT NULL,
    "renewsConnectionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAuthorizationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultKey" TEXT,
    "nameKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "type" TEXT,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "bankOperationType" TEXT,
    "manualCategory" TEXT,
    "manualCategoryKey" TEXT,
    "natureManual" "TransactionNature",
    "dedupeKey" TEXT,
    "dedupeKeyHash" TEXT,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'csv',
    "fileName" TEXT,
    "profile" TEXT NOT NULL DEFAULT 'generic',
    "rowCount" INTEGER NOT NULL,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategorizationRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "targetCategory" TEXT NOT NULL,
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategorizationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matchText" TEXT NOT NULL,
    "targetCategory" TEXT NOT NULL,
    "targetNature" "TransactionNature",
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultRuleKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyBudget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "categoryNameKey" TEXT,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT,
    "ipHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'LOGIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryNatureMapping" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "categoryNameKey" TEXT,
    "nature" "TransactionNature" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryNatureMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetWorthAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "NetWorthAccountType" NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "nameKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetWorthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetWorthSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "NetWorthAccountType" NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetWorthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsGoal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmountCents" INTEGER NOT NULL,
    "netWorthAccountId" TEXT,
    "currentAmountCents" INTEGER NOT NULL DEFAULT 0,
    "startingBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "targetDate" TIMESTAMP(3),
    "reachedAt" TIMESTAMP(3),
    "reachedBannerDismissedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingMfaChallenge_tokenHash_key" ON "PendingMfaChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "PendingMfaChallenge_userId_idx" ON "PendingMfaChallenge"("userId");

-- CreateIndex
CREATE INDEX "PendingMfaChallenge_expiresAt_idx" ON "PendingMfaChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_createdByUserId_idx" ON "Invitation"("createdByUserId");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Account_source_idx" ON "Account"("source");

-- CreateIndex
CREATE INDEX "Account_userId_source_nameKey_idx" ON "Account"("userId", "source", "nameKey");

-- CreateIndex
CREATE INDEX "Account_netWorthAccountId_idx" ON "Account"("netWorthAccountId");

-- CreateIndex
CREATE INDEX "Account_bankConnectionId_idx" ON "Account"("bankConnectionId");

-- CreateIndex
CREATE INDEX "Account_userId_source_providerAccountId_idx" ON "Account"("userId", "source", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_userId_name_source_key" ON "Account"("userId", "name", "source");

-- CreateIndex
CREATE INDEX "BankConnection_userId_idx" ON "BankConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAuthorizationRequest_stateHash_key" ON "BankAuthorizationRequest"("stateHash");

-- CreateIndex
CREATE INDEX "BankAuthorizationRequest_userId_idx" ON "BankAuthorizationRequest"("userId");

-- CreateIndex
CREATE INDEX "BankAuthorizationRequest_expiresAt_idx" ON "BankAuthorizationRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "Category_userId_idx" ON "Category"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_nameKey_key" ON "Category"("userId", "nameKey");

-- CreateIndex
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");

-- CreateIndex
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

-- CreateIndex
CREATE INDEX "Transaction_source_idx" ON "Transaction"("source");

-- CreateIndex
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");

-- CreateIndex
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");

-- CreateIndex
CREATE INDEX "Transaction_userId_date_idx" ON "Transaction"("userId", "date");

-- CreateIndex
CREATE INDEX "Transaction_userId_accountId_date_idx" ON "Transaction"("userId", "accountId", "date");

-- CreateIndex
CREATE INDEX "Transaction_userId_manualCategory_idx" ON "Transaction"("userId", "manualCategory");

-- CreateIndex
CREATE INDEX "Transaction_userId_manualCategoryKey_idx" ON "Transaction"("userId", "manualCategoryKey");

-- CreateIndex
CREATE INDEX "Transaction_userId_categoryId_idx" ON "Transaction"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "Transaction_userId_natureManual_idx" ON "Transaction"("userId", "natureManual");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_userId_dedupeKeyHash_key" ON "Transaction"("userId", "dedupeKeyHash");

-- CreateIndex
CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");

-- CreateIndex
CREATE INDEX "ImportBatch_source_idx" ON "ImportBatch"("source");

-- CreateIndex
CREATE INDEX "ImportBatch_userId_createdAt_idx" ON "ImportBatch"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CategorizationRule_userId_idx" ON "CategorizationRule"("userId");

-- CreateIndex
CREATE INDEX "CategorizationRule_userId_active_idx" ON "CategorizationRule"("userId", "active");

-- CreateIndex
CREATE INDEX "CategorizationRule_userId_targetCategory_idx" ON "CategorizationRule"("userId", "targetCategory");

-- CreateIndex
CREATE INDEX "CategoryRule_userId_idx" ON "CategoryRule"("userId");

-- CreateIndex
CREATE INDEX "CategoryRule_userId_enabled_idx" ON "CategoryRule"("userId", "enabled");

-- CreateIndex
CREATE INDEX "CategoryRule_userId_targetCategory_idx" ON "CategoryRule"("userId", "targetCategory");

-- CreateIndex
CREATE INDEX "MonthlyBudget_userId_idx" ON "MonthlyBudget"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyBudget_userId_categoryNameKey_key" ON "MonthlyBudget"("userId", "categoryNameKey");

-- CreateIndex
CREATE INDEX "LoginAttempt_emailHash_createdAt_idx" ON "LoginAttempt"("emailHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipHash_createdAt_idx" ON "LoginAttempt"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipHash_kind_createdAt_idx" ON "LoginAttempt"("ipHash", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "CategoryNatureMapping_userId_idx" ON "CategoryNatureMapping"("userId");

-- CreateIndex
CREATE INDEX "CategoryNatureMapping_userId_nature_idx" ON "CategoryNatureMapping"("userId", "nature");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryNatureMapping_userId_categoryNameKey_key" ON "CategoryNatureMapping"("userId", "categoryNameKey");

-- CreateIndex
CREATE INDEX "NetWorthAccount_userId_idx" ON "NetWorthAccount"("userId");

-- CreateIndex
CREATE INDEX "NetWorthAccount_userId_deletedAt_idx" ON "NetWorthAccount"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "NetWorthAccount_userId_nameKey_idx" ON "NetWorthAccount"("userId", "nameKey");

-- CreateIndex
CREATE INDEX "NetWorthSnapshot_userId_capturedAt_idx" ON "NetWorthSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "NetWorthSnapshot_accountId_capturedAt_idx" ON "NetWorthSnapshot"("accountId", "capturedAt");

-- CreateIndex
CREATE INDEX "SavingsGoal_userId_idx" ON "SavingsGoal"("userId");

-- CreateIndex
CREATE INDEX "SavingsGoal_userId_deletedAt_idx" ON "SavingsGoal"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "SavingsGoal_netWorthAccountId_idx" ON "SavingsGoal"("netWorthAccountId");

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingMfaChallenge" ADD CONSTRAINT "PendingMfaChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_netWorthAccountId_fkey" FOREIGN KEY ("netWorthAccountId") REFERENCES "NetWorthAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_bankConnectionId_fkey" FOREIGN KEY ("bankConnectionId") REFERENCES "BankConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAuthorizationRequest" ADD CONSTRAINT "BankAuthorizationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorizationRule" ADD CONSTRAINT "CategorizationRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryRule" ADD CONSTRAINT "CategoryRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyBudget" ADD CONSTRAINT "MonthlyBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryNatureMapping" ADD CONSTRAINT "CategoryNatureMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetWorthAccount" ADD CONSTRAINT "NetWorthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetWorthSnapshot" ADD CONSTRAINT "NetWorthSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "NetWorthAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_netWorthAccountId_fkey" FOREIGN KEY ("netWorthAccountId") REFERENCES "NetWorthAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
