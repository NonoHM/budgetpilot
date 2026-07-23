-- AlterTable
ALTER TABLE "Account" ADD COLUMN "providerAccountId" TEXT;

-- AlterTable
ALTER TABLE "BankConnection" ADD COLUMN "aspspCountry" TEXT;
ALTER TABLE "BankConnection" ADD COLUMN "aspspName" TEXT;

-- CreateTable
CREATE TABLE "BankAuthorizationRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "stateEncrypted" TEXT NOT NULL,
    "aspspName" TEXT NOT NULL,
    "aspspCountry" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankAuthorizationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "BankAuthorizationRequest_stateHash_key" ON "BankAuthorizationRequest"("stateHash");

-- CreateIndex
CREATE INDEX "BankAuthorizationRequest_userId_idx" ON "BankAuthorizationRequest"("userId");

-- CreateIndex
CREATE INDEX "BankAuthorizationRequest_expiresAt_idx" ON "BankAuthorizationRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "Account_userId_source_providerAccountId_idx" ON "Account"("userId", "source", "providerAccountId");
