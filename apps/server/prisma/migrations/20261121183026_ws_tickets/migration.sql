-- CreateTable
CREATE TABLE "ws_ticket" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ws_ticket_hash_key" ON "ws_ticket"("hash");

-- CreateIndex
CREATE INDEX "ws_ticket_expiresAt_idx" ON "ws_ticket"("expiresAt");

-- AddForeignKey
ALTER TABLE "ws_ticket" ADD CONSTRAINT "ws_ticket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
