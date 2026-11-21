import type { AppContext } from "../../container.js";
import type { JobPayload } from "../queue/jobs.js";
import type { JOBS } from "../queue/jobs.js";
import { upsertContactByChannel } from "../../domain/contacts/service.js";

/**
 * Paso 2→3 del flujo WhatsApp del diagrama: el adaptador de canal ya normalizó el mensaje;
 * aquí se resuelve contacto y conversación, se deduplica y se arranca el run.
 */
export type ChannelInboundDeps = Pick<AppContext, "db" | "log" | "conversations">;

export async function handleChannelInbound(ctx: ChannelInboundDeps, data: JobPayload<typeof JOBS.channelInbound>): Promise<void> {
  const connection = await ctx.db.connection.findFirst({ where: { id: data.connectionId, workspaceId: data.workspaceId } });
  if (!connection || connection.status === "DISABLED") {
    ctx.log.warn({ connectionId: data.connectionId }, "inbound de una conexión inexistente");
    return;
  }
  const agentId = (connection.config as { agentId?: string }).agentId;
  if (!agentId) {
    ctx.log.warn({ connectionId: connection.id }, "la conexión de canal no tiene agentId configurado");
    return;
  }
  const contact = await upsertContactByChannel(ctx.db, {
    workspaceId: data.workspaceId,
    channel: data.channel,
    externalId: data.from.id,
    ...(data.from.phone ? { phone: data.from.phone } : {}),
    name: data.from.name,
  });
  const conversation = await ctx.db.conversation.upsert({
    where: { workspaceId_channel_externalThreadId: { workspaceId: data.workspaceId, channel: data.channel, externalThreadId: data.externalThreadId } },
    update: {},
    create: {
      workspaceId: data.workspaceId,
      agentId,
      contactId: contact.id,
      channel: data.channel,
      connectionId: connection.id,
      externalThreadId: data.externalThreadId,
    },
  });
  await ctx.conversations.receive({
    workspaceId: data.workspaceId,
    conversationId: conversation.id,
    text: data.text,
    author: "CONTACT",
    channelMessageId: data.channelMessageId,
    trigger: "channel.inbound",
  });
}
