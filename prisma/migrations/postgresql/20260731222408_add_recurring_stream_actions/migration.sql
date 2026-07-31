-- CreateEnum
CREATE TYPE "RecurringActionKind" AS ENUM ('IGNORE', 'PAID', 'EXCLUDE');

-- CreateTable
CREATE TABLE "RecurringStreamAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "RecurringActionKind" NOT NULL,
    "direction" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "anchorTransactionIds" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringStreamAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringStreamAction_userId_idx" ON "RecurringStreamAction"("userId");

-- CreateIndex
CREATE INDEX "RecurringStreamAction_userId_kind_idx" ON "RecurringStreamAction"("userId", "kind");

-- AddForeignKey
ALTER TABLE "RecurringStreamAction" ADD CONSTRAINT "RecurringStreamAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

