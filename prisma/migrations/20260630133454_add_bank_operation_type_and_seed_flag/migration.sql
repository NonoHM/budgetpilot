-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "bankOperationType" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "defaultsSeededAt" DATETIME;
