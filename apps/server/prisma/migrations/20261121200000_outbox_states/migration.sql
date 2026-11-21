-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalStatus" ADD VALUE 'EXECUTING';
ALTER TYPE "ApprovalStatus" ADD VALUE 'UNKNOWN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageStatus" ADD VALUE 'SENDING';
ALTER TYPE "MessageStatus" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "message" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "run_step" ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "message_workspaceId_idempotencyKey_key" ON "message"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "run_step_runId_dedupeKey_key" ON "run_step"("runId", "dedupeKey");

