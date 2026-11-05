-- Which onion layer produced each kept column designation (#1207): four nullable columns on
-- ColumnMapping, one per stored role. Written only by the server (`layerAtSave`,
-- src/lib/domain/designationLayer.ts) and by the backup restore, never posted by a client.
--
-- Additive: no existing row changes and no value is stamped, so every mapping written before this
-- migration reads unknown and its rows show « Remembered » with no claim about where it came from.
-- Prisma's statements, unchanged, so `prisma migrate diff` still matches. `migrate deploy` wraps
-- nothing in a transaction: a failure between statements leaves the migration marked failed and
-- the boot refuses to start; no stored figure is damaged. Recovery is by hand from the statement
-- that failed onward.

-- AlterTable
ALTER TABLE `ColumnMapping` ADD COLUMN `amountLayer` ENUM('remembered', 'file', 'rule', 'model', 'member') NULL,
    ADD COLUMN `categoryLayer` ENUM('remembered', 'file', 'rule', 'model', 'member') NULL,
    ADD COLUMN `dateLayer` ENUM('remembered', 'file', 'rule', 'model', 'member') NULL,
    ADD COLUMN `labelLayer` ENUM('remembered', 'file', 'rule', 'model', 'member') NULL,
    ADD COLUMN `layersKey` VARCHAR(191) NULL;
