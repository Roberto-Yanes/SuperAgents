-- Extensiones: pgvector (RAG y memoria) y btree_gist (restricción de no solape de citas).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "StageKind" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'STOPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "state" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "memory" ADD COLUMN     "embedding" vector,
ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "routine" ADD COLUMN     "conversationId" UUID;

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
ADD COLUMN     "parentRunId" UUID,
ADD COLUMN     "parentToolCallId" TEXT;

-- CreateTable
CREATE TABLE "pipeline_stage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "StageKind" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "value" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" TEXT,
    "notes" TEXT,
    "ownerId" TEXT,
    "externalIds" JSONB NOT NULL DEFAULT '{}',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "slotMinutes" INTEGER NOT NULL DEFAULT 30,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "minNoticeMinutes" INTEGER NOT NULL DEFAULT 60,
    "maxDaysAhead" INTEGER NOT NULL DEFAULT 30,
    "hours" JSONB NOT NULL DEFAULT '{}',
    "reminderMinutes" INTEGER NOT NULL DEFAULT 1440,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "contactId" UUID,
    "conversationId" UUID,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "externalEventId" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_enrollment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "contactId" UUID,
    "conversationId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "stoppedReason" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_document" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "mimeType" TEXT NOT NULL DEFAULT 'text/plain',
    "fileId" UUID,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PROCESSING',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunk" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector,
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_file" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipeline_stage_workspaceId_position_idx" ON "pipeline_stage"("workspaceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stage_workspaceId_name_key" ON "pipeline_stage"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "lead_workspaceId_stageId_idx" ON "lead"("workspaceId", "stageId");

-- CreateIndex
CREATE INDEX "lead_workspaceId_contactId_idx" ON "lead"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_workspaceId_name_key" ON "calendar"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "appointment_workspaceId_calendarId_startsAt_idx" ON "appointment"("workspaceId", "calendarId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_workspaceId_name_key" ON "sequence"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "sequence_enrollment_workspaceId_status_idx" ON "sequence_enrollment"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "sequence_enrollment_conversationId_status_idx" ON "sequence_enrollment"("conversationId", "status");

-- CreateIndex
CREATE INDEX "knowledge_document_workspaceId_idx" ON "knowledge_document"("workspaceId");

-- CreateIndex
CREATE INDEX "knowledge_chunk_workspaceId_idx" ON "knowledge_chunk"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunk_documentId_index_key" ON "knowledge_chunk"("documentId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_storageKey_key" ON "stored_file"("storageKey");

-- CreateIndex
CREATE INDEX "stored_file_workspaceId_idx" ON "stored_file"("workspaceId");

-- AddForeignKey
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "pipeline_stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence" ADD CONSTRAINT "sequence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "knowledge_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Agenda: dos citas BOOKED del mismo calendario no pueden solaparse (garantía en base de datos).
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist ("calendarId" WITH =, tsrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE (status = 'BOOKED');
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_valid_range" CHECK ("endsAt" > "startsAt");

-- Secuencias: una sola inscripción activa por secuencia y conversación.
CREATE UNIQUE INDEX "sequence_enrollment_one_active" ON "sequence_enrollment" ("sequenceId", "conversationId") WHERE status = 'ACTIVE';
