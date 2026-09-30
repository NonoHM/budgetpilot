-- #599, #696: the import memory is keyed on the file's FULL account identifier, not on its shape.
--
-- `ImportSourceSignature` keyed an account on a header SHAPE plus a four-character fragment. It is
-- dropped rather than converted: a row holds no full identifier to derive the new key from. It had
-- no production writer (#696), so the only rows it can hold are ones a restore wrote from a backup,
-- and a backup could only carry rows an earlier restore wrote. `RememberedAccount` starts empty,
-- and the next statement of each account asks once, as on an install that never had the memory.

-- DropForeignKey
ALTER TABLE "ImportSourceSignature" DROP CONSTRAINT "ImportSourceSignature_accountId_fkey";

-- DropForeignKey
ALTER TABLE "ImportSourceSignature" DROP CONSTRAINT "ImportSourceSignature_userId_fkey";

-- DropTable
DROP TABLE "ImportSourceSignature";

-- CreateTable
CREATE TABLE "RememberedAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "identifierKey" TEXT NOT NULL,
    "fragment" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "rememberedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RememberedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RememberedAccount_accountId_idx" ON "RememberedAccount"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "RememberedAccount_userId_identifierKey_key" ON "RememberedAccount"("userId", "identifierKey");

-- AddForeignKey
ALTER TABLE "RememberedAccount" ADD CONSTRAINT "RememberedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RememberedAccount" ADD CONSTRAINT "RememberedAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
