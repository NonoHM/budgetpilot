-- CreateTable
CREATE TABLE "ColumnMapping" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "matchBy" TEXT NOT NULL DEFAULT 'name',
    "dateColumn" TEXT,
    "labelColumn" TEXT,
    "amountColumn" TEXT,
    "categoryColumn" TEXT,
    "dateIndex" INTEGER,
    "labelIndex" INTEGER,
    "amountIndex" INTEGER,
    "categoryIndex" INTEGER,
    "columnCount" INTEGER NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColumnMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ColumnMapping_userId_idx" ON "ColumnMapping"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ColumnMapping_userId_fingerprint_key" ON "ColumnMapping"("userId", "fingerprint");

-- AddForeignKey
ALTER TABLE "ColumnMapping" ADD CONSTRAINT "ColumnMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
