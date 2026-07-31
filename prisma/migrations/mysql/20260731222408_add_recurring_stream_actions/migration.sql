-- CreateTable
CREATE TABLE `RecurringStreamAction` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `kind` ENUM('IGNORE', 'PAID', 'EXCLUDE') NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `normalizedLabel` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `anchorTransactionIds` TEXT NOT NULL,
    `dueDate` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RecurringStreamAction_userId_idx`(`userId`),
    INDEX `RecurringStreamAction_userId_kind_idx`(`userId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RecurringStreamAction` ADD CONSTRAINT `RecurringStreamAction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

