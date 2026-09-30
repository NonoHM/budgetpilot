-- #599, #696: the import memory is keyed on the file's FULL account identifier, not on its shape.
--
-- `ImportSourceSignature` keyed an account on a header SHAPE plus a four-character fragment. It is
-- dropped rather than converted: a row holds no full identifier to derive the new key from. It had
-- no production writer (#696), so the only rows it can hold are ones a restore wrote from a backup,
-- and a backup could only carry rows an earlier restore wrote. `RememberedAccount` starts empty,
-- and the next statement of each account asks once, as on an install that never had the memory.
--
-- `identifierKey` sits under this table's case-insensitive collation, which cannot merge two keys:
-- the writer only ever stores lowercase hex, so no two keys differ by case alone.

-- DropForeignKey
ALTER TABLE `ImportSourceSignature` DROP FOREIGN KEY `ImportSourceSignature_accountId_fkey`;

-- DropForeignKey
ALTER TABLE `ImportSourceSignature` DROP FOREIGN KEY `ImportSourceSignature_userId_fkey`;

-- DropTable
DROP TABLE `ImportSourceSignature`;

-- CreateTable
CREATE TABLE `RememberedAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `identifierKey` VARCHAR(191) NOT NULL,
    `fragment` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `useCount` INTEGER NOT NULL DEFAULT 1,
    `rememberedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RememberedAccount_accountId_idx`(`accountId`),
    UNIQUE INDEX `RememberedAccount_userId_identifierKey_key`(`userId`, `identifierKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RememberedAccount` ADD CONSTRAINT `RememberedAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RememberedAccount` ADD CONSTRAINT `RememberedAccount_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
