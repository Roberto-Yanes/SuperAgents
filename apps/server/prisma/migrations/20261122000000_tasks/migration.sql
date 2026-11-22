-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('APP', 'CHANNEL', 'ROUTINE', 'DELEGATION');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PLANNING', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_EXTERNAL', 'WAITING_CHILD', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "RunStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "taskId" UUID;

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "goal" TEXT NOT NULL,
    "source" "TaskSource" NOT NULL,
    "launchedBy" TEXT NOT NULL,
    "conversationId" UUID,
    "contactId" UUID,
    "parentTaskId" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" "TaskStatus" NOT NULL DEFAULT 'PLANNING',
    "plan" JSONB NOT NULL DEFAULT '[]',
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB NOT NULL DEFAULT '{}',
    "limits" JSONB NOT NULL,
    "spentSteps" INTEGER NOT NULL DEFAULT 0,
    "spentCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "elapsedMs" INTEGER NOT NULL DEFAULT 0,
    "segmentStartedAt" TIMESTAMP(3),
    "checkpoint" JSONB NOT NULL DEFAULT '[]',
    "blockedReason" TEXT,
    "waiting" JSONB,
    "result" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_workspaceId_status_idx" ON "task"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "task_workspaceId_conversationId_idx" ON "task"("workspaceId", "conversationId");

-- CreateIndex
CREATE INDEX "task_parentTaskId_idx" ON "task"("parentTaskId");

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

