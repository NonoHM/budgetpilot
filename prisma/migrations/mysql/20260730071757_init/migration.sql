-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `role` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `forcePasswordChange` BOOLEAN NOT NULL DEFAULT false,
    `defaultsSeededAt` DATETIME(3) NULL,
    `defaultRulesSeededAt` DATETIME(3) NULL,
    `aiInsightsEnabled` BOOLEAN NOT NULL DEFAULT true,
    `aiIncludeLabels` BOOLEAN NOT NULL DEFAULT false,
    `totpSecretEncrypted` TEXT NULL,
    `totpEnabled` BOOLEAN NOT NULL DEFAULT false,
    `totpEnabledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RecoveryCode` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RecoveryCode_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PendingMfaChallenge` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PendingMfaChallenge_tokenHash_key`(`tokenHash`),
    INDEX `PendingMfaChallenge_userId_idx`(`userId`),
    INDEX `PendingMfaChallenge_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Session_tokenHash_key`(`tokenHash`),
    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Invitation` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `usedByUserId` VARCHAR(191) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Invitation_tokenHash_key`(`tokenHash`),
    INDEX `Invitation_createdByUserId_idx`(`createdByUserId`),
    INDEX `Invitation_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Account` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'EUR',
    `source` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `netWorthAccountId` VARCHAR(191) NULL,
    `bankConnectionId` VARCHAR(191) NULL,
    `providerAccountId` VARCHAR(191) NULL,
    `providerCashAccountType` VARCHAR(191) NULL,
    `nameKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Account_userId_idx`(`userId`),
    INDEX `Account_source_idx`(`source`),
    INDEX `Account_userId_source_nameKey_idx`(`userId`, `source`, `nameKey`),
    INDEX `Account_netWorthAccountId_idx`(`netWorthAccountId`),
    INDEX `Account_bankConnectionId_idx`(`bankConnectionId`),
    INDEX `Account_userId_source_providerAccountId_idx`(`userId`, `source`, `providerAccountId`),
    UNIQUE INDEX `Account_userId_name_source_key`(`userId`, `name`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BankConnection` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerSessionId` VARCHAR(191) NULL,
    `credentialsEncrypted` TEXT NULL,
    `status` ENUM('active', 'expired', 'revoked', 'error') NOT NULL DEFAULT 'active',
    `aspspName` VARCHAR(191) NULL,
    `aspspCountry` VARCHAR(191) NULL,
    `consentExpiresAt` DATETIME(3) NULL,
    `lastSyncAt` DATETIME(3) NULL,
    `lastSyncStatus` VARCHAR(191) NULL,
    `lastSyncError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BankConnection_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BankAuthorizationRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `stateHash` VARCHAR(191) NOT NULL,
    `stateEncrypted` TEXT NOT NULL,
    `aspspName` VARCHAR(191) NOT NULL,
    `aspspCountry` VARCHAR(191) NOT NULL,
    `renewsConnectionId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `BankAuthorizationRequest_stateHash_key`(`stateHash`),
    INDEX `BankAuthorizationRequest_userId_idx`(`userId`),
    INDEX `BankAuthorizationRequest_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Category` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `defaultKey` VARCHAR(191) NULL,
    `nameKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Category_userId_idx`(`userId`),
    UNIQUE INDEX `Category_userId_nameKey_key`(`userId`, `nameKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Transaction` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `categoryId` VARCHAR(191) NOT NULL,
    `importBatchId` VARCHAR(191) NULL,
    `date` DATETIME(3) NOT NULL,
    `label` TEXT NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `type` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `bankOperationType` VARCHAR(191) NULL,
    `manualCategory` VARCHAR(191) NULL,
    `manualCategoryKey` VARCHAR(191) NULL,
    `natureManual` ENUM('income', 'spending', 'transfer', 'investment', 'refund', 'fee', 'uncategorized') NULL,
    `dedupeKey` TEXT NULL,
    `dedupeKeyHash` VARCHAR(191) NULL,
    `metadataJson` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Transaction_userId_idx`(`userId`),
    INDEX `Transaction_date_idx`(`date`),
    INDEX `Transaction_source_idx`(`source`),
    INDEX `Transaction_type_idx`(`type`),
    INDEX `Transaction_importBatchId_idx`(`importBatchId`),
    INDEX `Transaction_userId_date_idx`(`userId`, `date`),
    INDEX `Transaction_userId_accountId_date_idx`(`userId`, `accountId`, `date`),
    INDEX `Transaction_userId_manualCategory_idx`(`userId`, `manualCategory`),
    INDEX `Transaction_userId_manualCategoryKey_idx`(`userId`, `manualCategoryKey`),
    INDEX `Transaction_userId_categoryId_idx`(`userId`, `categoryId`),
    INDEX `Transaction_userId_natureManual_idx`(`userId`, `natureManual`),
    UNIQUE INDEX `Transaction_userId_dedupeKeyHash_key`(`userId`, `dedupeKeyHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ImportBatch` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'csv',
    `fileName` TEXT NULL,
    `profile` VARCHAR(191) NOT NULL DEFAULT 'generic',
    `rowCount` INTEGER NOT NULL,
    `importedRows` INTEGER NOT NULL DEFAULT 0,
    `duplicateRows` INTEGER NOT NULL DEFAULT 0,
    `invalidRows` INTEGER NOT NULL DEFAULT 0,
    `periodStart` DATETIME(3) NULL,
    `periodEnd` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ImportBatch_userId_idx`(`userId`),
    INDEX `ImportBatch_source_idx`(`source`),
    INDEX `ImportBatch_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CategorizationRule` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `pattern` TEXT NOT NULL,
    `targetCategory` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CategorizationRule_userId_idx`(`userId`),
    INDEX `CategorizationRule_userId_active_idx`(`userId`, `active`),
    INDEX `CategorizationRule_userId_targetCategory_idx`(`userId`, `targetCategory`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CategoryRule` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `matchText` TEXT NOT NULL,
    `targetCategory` VARCHAR(191) NOT NULL,
    `targetNature` ENUM('income', 'spending', 'transfer', 'investment', 'refund', 'fee', 'uncategorized') NULL,
    `isRegex` BOOLEAN NOT NULL DEFAULT false,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `defaultRuleKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CategoryRule_userId_idx`(`userId`),
    INDEX `CategoryRule_userId_enabled_idx`(`userId`, `enabled`),
    INDEX `CategoryRule_userId_targetCategory_idx`(`userId`, `targetCategory`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MonthlyBudget` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `categoryName` VARCHAR(191) NOT NULL,
    `categoryNameKey` VARCHAR(191) NULL,
    `amountCents` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MonthlyBudget_userId_idx`(`userId`),
    UNIQUE INDEX `MonthlyBudget_userId_categoryNameKey_key`(`userId`, `categoryNameKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LoginAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `emailHash` VARCHAR(191) NULL,
    `ipHash` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'LOGIN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LoginAttempt_emailHash_createdAt_idx`(`emailHash`, `createdAt`),
    INDEX `LoginAttempt_ipHash_createdAt_idx`(`ipHash`, `createdAt`),
    INDEX `LoginAttempt_ipHash_kind_createdAt_idx`(`ipHash`, `kind`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CategoryNatureMapping` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `categoryName` VARCHAR(191) NOT NULL,
    `categoryNameKey` VARCHAR(191) NULL,
    `nature` ENUM('income', 'spending', 'transfer', 'investment', 'refund', 'fee', 'uncategorized') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CategoryNatureMapping_userId_idx`(`userId`),
    INDEX `CategoryNatureMapping_userId_nature_idx`(`userId`, `nature`),
    UNIQUE INDEX `CategoryNatureMapping_userId_categoryNameKey_key`(`userId`, `categoryNameKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NetWorthAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('checking', 'savings', 'investment', 'debt', 'real_estate', 'other') NOT NULL,
    `balanceCents` INTEGER NOT NULL,
    `deletedAt` DATETIME(3) NULL,
    `nameKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NetWorthAccount_userId_idx`(`userId`),
    INDEX `NetWorthAccount_userId_deletedAt_idx`(`userId`, `deletedAt`),
    INDEX `NetWorthAccount_userId_nameKey_idx`(`userId`, `nameKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NetWorthSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `type` ENUM('checking', 'savings', 'investment', 'debt', 'real_estate', 'other') NOT NULL,
    `balanceCents` INTEGER NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `NetWorthSnapshot_userId_capturedAt_idx`(`userId`, `capturedAt`),
    INDEX `NetWorthSnapshot_accountId_capturedAt_idx`(`accountId`, `capturedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SavingsGoal` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `targetAmountCents` INTEGER NOT NULL,
    `netWorthAccountId` VARCHAR(191) NULL,
    `currentAmountCents` INTEGER NOT NULL DEFAULT 0,
    `startingBalanceCents` INTEGER NOT NULL DEFAULT 0,
    `targetDate` DATETIME(3) NULL,
    `reachedAt` DATETIME(3) NULL,
    `reachedBannerDismissedAt` DATETIME(3) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SavingsGoal_userId_idx`(`userId`),
    INDEX `SavingsGoal_userId_deletedAt_idx`(`userId`, `deletedAt`),
    INDEX `SavingsGoal_netWorthAccountId_idx`(`netWorthAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RecoveryCode` ADD CONSTRAINT `RecoveryCode_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PendingMfaChallenge` ADD CONSTRAINT `PendingMfaChallenge_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Invitation` ADD CONSTRAINT `Invitation_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Invitation` ADD CONSTRAINT `Invitation_usedByUserId_fkey` FOREIGN KEY (`usedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Account` ADD CONSTRAINT `Account_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Account` ADD CONSTRAINT `Account_netWorthAccountId_fkey` FOREIGN KEY (`netWorthAccountId`) REFERENCES `NetWorthAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Account` ADD CONSTRAINT `Account_bankConnectionId_fkey` FOREIGN KEY (`bankConnectionId`) REFERENCES `BankConnection`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BankConnection` ADD CONSTRAINT `BankConnection_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BankAuthorizationRequest` ADD CONSTRAINT `BankAuthorizationRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Category` ADD CONSTRAINT `Category_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_importBatchId_fkey` FOREIGN KEY (`importBatchId`) REFERENCES `ImportBatch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportBatch` ADD CONSTRAINT `ImportBatch_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CategorizationRule` ADD CONSTRAINT `CategorizationRule_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CategoryRule` ADD CONSTRAINT `CategoryRule_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MonthlyBudget` ADD CONSTRAINT `MonthlyBudget_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CategoryNatureMapping` ADD CONSTRAINT `CategoryNatureMapping_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NetWorthAccount` ADD CONSTRAINT `NetWorthAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NetWorthSnapshot` ADD CONSTRAINT `NetWorthSnapshot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `NetWorthAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SavingsGoal` ADD CONSTRAINT `SavingsGoal_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SavingsGoal` ADD CONSTRAINT `SavingsGoal_netWorthAccountId_fkey` FOREIGN KEY (`netWorthAccountId`) REFERENCES `NetWorthAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
