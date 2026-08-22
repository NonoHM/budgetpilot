-- AlterTable
ALTER TABLE `Account` ADD COLUMN `archivedAt` DATETIME(3) NULL,
    ADD COLUMN `discriminant` VARCHAR(191) NULL,
    ADD COLUMN `institution` VARCHAR(191) NULL;

-- AlterTable
-- accountId is NULLABLE HERE AND REQUIRED IN THE DATAMODEL, AND THE DIVERGENCE IS DELIBERATE.
-- This table already holds rows on every existing install, so NOT NULL would abort the upgrade
-- under strict mode and, without it, MySQL would fill every legacy row with the implicit ""
-- default and the foreign key below would then reject them. No DEFAULT either: a default would
-- file every legacy batch into one invented account and nothing would ever report it. The
-- backfill reads each batch's own transactions; the NOT NULL tightening is a later migration,
-- once every row carries one.
ALTER TABLE `ImportBatch` ADD COLUMN `accountId` VARCHAR(191) NULL,
    ADD COLUMN `dateOrder` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `ImportSourceSignature` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `fingerprint` VARCHAR(191) NOT NULL,
    `discriminant` VARCHAR(191) NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `useCount` INTEGER NOT NULL DEFAULT 0,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ImportSourceSignature_userId_idx`(`userId`),
    INDEX `ImportSourceSignature_accountId_idx`(`accountId`),
    UNIQUE INDEX `ImportSourceSignature_userId_fingerprint_discriminant_key`(`userId`, `fingerprint`, `discriminant`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Account_userId_archivedAt_idx` ON `Account`(`userId`, `archivedAt`);

-- CreateIndex
CREATE INDEX `ImportBatch_accountId_idx` ON `ImportBatch`(`accountId`);

-- AddForeignKey
ALTER TABLE `ImportBatch` ADD CONSTRAINT `ImportBatch_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportSourceSignature` ADD CONSTRAINT `ImportSourceSignature_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportSourceSignature` ADD CONSTRAINT `ImportSourceSignature_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
