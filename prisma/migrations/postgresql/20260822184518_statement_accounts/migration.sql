-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "discriminant" TEXT,
ADD COLUMN     "institution" TEXT;

-- AlterTable
-- accountId is NULLABLE HERE AND REQUIRED IN THE DATAMODEL, AND THE DIVERGENCE IS DELIBERATE.
-- This table already holds rows on every existing install, so NOT NULL would abort the upgrade.
-- No DEFAULT either: a default would file every legacy batch into one invented account and
-- nothing would ever report it. The backfill reads each batch's own transactions; the NOT NULL
-- tightening is a later migration, once every row carries one.
ALTER TABLE "ImportBatch" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "dateOrder" TEXT;

-- CreateTable
CREATE TABLE "ImportSourceSignature" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "discriminant" TEXT,
    "accountId" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportSourceSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportSourceSignature_userId_idx" ON "ImportSourceSignature"("userId");

-- CreateIndex
CREATE INDEX "ImportSourceSignature_accountId_idx" ON "ImportSourceSignature"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportSourceSignature_userId_fingerprint_discriminant_key" ON "ImportSourceSignature"("userId", "fingerprint", "discriminant");

-- CreateIndex
CREATE INDEX "Account_userId_archivedAt_idx" ON "Account"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "ImportBatch_accountId_idx" ON "ImportBatch"("accountId");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportSourceSignature" ADD CONSTRAINT "ImportSourceSignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportSourceSignature" ADD CONSTRAINT "ImportSourceSignature_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
