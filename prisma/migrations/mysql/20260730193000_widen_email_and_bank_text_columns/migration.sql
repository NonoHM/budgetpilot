-- AlterTable
ALTER TABLE `Account` MODIFY `name` VARCHAR(255) NOT NULL,
    MODIFY `nameKey` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `BankAuthorizationRequest` MODIFY `aspspName` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `BankConnection` MODIFY `aspspName` TEXT NULL;

-- AlterTable
ALTER TABLE `Invitation` MODIFY `email` VARCHAR(254) NULL;

-- AlterTable
ALTER TABLE `Transaction` MODIFY `bankOperationType` TEXT NULL;

-- AlterTable
ALTER TABLE `User` MODIFY `email` VARCHAR(254) NOT NULL;

