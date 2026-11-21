-- Identidad de contacto única por canal (N2) y conversación única por conexión (N4).
-- La clave de Composio deja de vivir en la conexión (D2): se anula el secreto de ese tipo
-- sin tocar el resto de conexiones.

-- CreateTable
CREATE TABLE "contact_identity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_identity_workspaceId_channel_externalId_key" ON "contact_identity"("workspaceId", "channel", "externalId");

-- CreateIndex
CREATE INDEX "contact_identity_workspaceId_contactId_idx" ON "contact_identity"("workspaceId", "contactId");

-- AddForeignKey
ALTER TABLE "contact_identity" ADD CONSTRAINT "contact_identity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identity" ADD CONSTRAINT "contact_identity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill desde externalIds. Si dos contactos comparten el mismo id, se queda el primero.
INSERT INTO "contact_identity" ("id", "workspaceId", "contactId", "channel", "externalId")
SELECT gen_random_uuid(), c."workspaceId", c.id, e.key, e.value
FROM "contact" c
CROSS JOIN LATERAL jsonb_each_text(c."externalIds") AS e(key, value)
WHERE e.value IS NOT NULL AND e.value <> ''
ON CONFLICT ("workspaceId", "channel", "externalId") DO NOTHING;

-- Si el workspace tiene una sola conexión de WhatsApp, las conversaciones viejas sin connectionId se le asignan.
-- Con dos o más no se adivina: se dejan en null y el próximo mensaje abre la conversación de esa conexión.
UPDATE "conversation" AS c
SET "connectionId" = only_one.id
FROM (
    SELECT "workspaceId", (array_agg(id))[1] AS id
    FROM "connection"
    WHERE kind IN ('channel.whatsapp_cloud', 'channel.whatsapp_baileys')
    GROUP BY "workspaceId"
    HAVING count(*) = 1
) AS only_one
WHERE c."workspaceId" = only_one."workspaceId"
  AND c."connectionId" IS NULL
  AND c.channel = 'whatsapp'
  AND c."externalThreadId" IS NOT NULL;

-- DropIndex
DROP INDEX "conversation_workspaceId_channel_externalThreadId_key";

-- CreateIndex
CREATE UNIQUE INDEX "conversation_workspaceId_connectionId_externalThreadId_key" ON "conversation"("workspaceId", "connectionId", "externalThreadId");

-- D2: el secreto por conexión de Composio ya no se usa. El resto de kinds no se toca.
UPDATE "connection" SET "secretEnc" = NULL WHERE kind = 'composio';
