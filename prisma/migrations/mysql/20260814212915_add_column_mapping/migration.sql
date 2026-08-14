-- CreateTable
CREATE TABLE `ColumnMapping` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `fingerprint` VARCHAR(191) NOT NULL,
    `matchBy` VARCHAR(191) NOT NULL DEFAULT 'name',
    `dateColumn` VARCHAR(191) NULL,
    `labelColumn` VARCHAR(191) NULL,
    `amountColumn` VARCHAR(191) NULL,
    `categoryColumn` VARCHAR(191) NULL,
    `dateIndex` INTEGER NULL,
    `labelIndex` INTEGER NULL,
    `amountIndex` INTEGER NULL,
    `categoryIndex` INTEGER NULL,
    `columnCount` INTEGER NOT NULL,
    `useCount` INTEGER NOT NULL DEFAULT 0,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ColumnMapping_userId_idx`(`userId`),
    UNIQUE INDEX `ColumnMapping_userId_fingerprint_key`(`userId`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ColumnMapping` ADD CONSTRAINT `ColumnMapping_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
