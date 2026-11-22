-- AlterTable
ALTER TABLE "run" ADD COLUMN     "model" TEXT;

-- CreateIndex
CREATE INDEX "run_workspaceId_createdAt_idx" ON "run"("workspaceId", "createdAt");

