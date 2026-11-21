-- AlterTable
ALTER TABLE "run" ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "recoveries" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "run_status_heartbeatAt_idx" ON "run"("status", "heartbeatAt");
