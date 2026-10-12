-- The instance-wide AI kill switch (#986): one table, empty until an admin halts inference.
--
-- Additive: no existing table or row changes. Prisma's statements, unchanged, so
-- `prisma migrate diff` still matches. Where the engine needs more than one statement, a failure
-- between them leaves the migration marked failed and the boot refuses to start (`migrate deploy`
-- wraps nothing in a transaction); no row exists yet for a partial run to damage.

-- CreateTable
CREATE TABLE "InferenceHalt" (
    "id" INTEGER NOT NULL,
    "haltedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "haltedById" TEXT,

    CONSTRAINT "InferenceHalt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InferenceHalt_haltedById_idx" ON "InferenceHalt"("haltedById");

-- AddForeignKey
ALTER TABLE "InferenceHalt" ADD CONSTRAINT "InferenceHalt_haltedById_fkey" FOREIGN KEY ("haltedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

