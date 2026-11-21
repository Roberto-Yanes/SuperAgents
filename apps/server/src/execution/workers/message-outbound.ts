import type { AppContext } from "../../container.js";
import type { JobPayload } from "../queue/jobs.js";
import type { JOBS } from "../queue/jobs.js";
import { decryptJson } from "../../shared/security/crypto.js";
import { ChannelDeliveryUnknownError, RetryableChannelError } from "../../integrations/channels/adapter.js";

/** Reintentos de pg-boss configurados por cola (execution/queue/boss.ts). */
const MAX_RETRIES = 3;
/** Plazo de un envío en curso (muy por encima del timeout de los adaptadores, 15 s). */
const SEND_LEASE_MS = 2 * 60_000;

/**
 * Pasos 5→6 del diagrama: outbox → adaptador del canal → envío al contacto.
 *
 * Máquina de estados (H4): QUEUED → SENDING (toma condicionada) → SENT | FAILED | UNKNOWN.
 * - Error temporal con certeza de no envío: SENDING → QUEUED y pg-boss reintenta.
 * - Un job que encuentra el mensaje en SENDING es un reintento tras una caída a mitad de envío: UNKNOWN, no se reenvía.
 */
export type MessageOutboundDeps = Pick<AppContext, "db" | "bus" | "channels" | "secretKeys">;

export async function handleMessageOutbound(ctx: MessageOutboundDeps, data: JobPayload<typeof JOBS.messageOutbound>, retryCount = 0): Promise<void> {
  const message = await ctx.db.message.findFirst({
    where: { id: data.messageId, workspaceId: data.workspaceId },
    include: { conversation: true },
  });
  if (!message) return;
  if (message.status === "SENDING") {
    // Dentro del arrendamiento: otro worker lo está enviando ahora mismo. Fuera: aquel worker murió a mitad.
    if (message.sendingAt && Date.now() - message.sendingAt.getTime() < SEND_LEASE_MS) return;
    return markUnknown(ctx, message, "El envío se interrumpió (caída del worker); puede haber llegado");
  }
  if (message.status !== "QUEUED") return; // ya enviado, fallido o cancelado: idempotente
  const claimed = await ctx.db.message.updateMany({ where: { id: message.id, status: "QUEUED" }, data: { status: "SENDING", sendingAt: new Date() } });
  if (claimed.count !== 1) return; // otro worker lo tomó

  const fail = async (error: string) => {
    await ctx.db.message.updateMany({ where: { id: message.id, status: { in: ["SENDING", "QUEUED"] } }, data: { status: "FAILED", payload: { error } } });
    await ctx.bus.publish({
      workspaceId: data.workspaceId,
      type: "message.failed",
      subject: `conversation:${message.conversationId}`,
      data: { messageId: message.id, error },
    });
  };

  try {
    // La respuesta sale por la misma conexión por la que entró la conversación.
    const conn = message.conversation.connectionId
      ? await ctx.db.connection.findFirst({ where: { id: message.conversation.connectionId, workspaceId: data.workspaceId } })
      : null;
    if (message.conversation.connectionId && (!conn || conn.status === "DISABLED")) return fail("La conexión del canal no existe o está desactivada");
    const adapter = ctx.channels.forConnectionKind(conn?.kind ?? null);
    if (!adapter) return fail(`Sin adaptador para ${conn?.kind ?? "api"}`);
    adapter.assertCanSend?.(message.conversation);
    const connection = conn
      ? { id: conn.id, config: conn.config, secret: conn.secretEnc ? decryptJson(conn.secretEnc, ctx.secretKeys, `connection:${conn.id}`) : null }
      : null;
    const sent = await adapter.send(
      {
        workspaceId: data.workspaceId,
        conversationId: message.conversationId,
        externalThreadId: message.conversation.externalThreadId,
        text: message.text ?? "",
        idempotencyKey: message.id,
      },
      connection,
    );
    await ctx.db.message.updateMany({ where: { id: message.id, status: "SENDING" }, data: { status: "SENT", channelMessageId: sent.channelMessageId } });
    await ctx.bus.publish({
      workspaceId: data.workspaceId,
      type: "message.sent",
      subject: `conversation:${message.conversationId}`,
      data: { messageId: message.id },
    });
  } catch (err) {
    if (err instanceof ChannelDeliveryUnknownError) return markUnknown(ctx, message, err.message);
    // Error temporal con certeza de no envío y quedan reintentos: vuelve a QUEUED y pg-boss reintenta con backoff.
    if (err instanceof RetryableChannelError && retryCount < MAX_RETRIES) {
      await ctx.db.message.updateMany({ where: { id: message.id, status: "SENDING" }, data: { status: "QUEUED" } });
      throw err;
    }
    await fail(err instanceof Error ? err.message : String(err));
  }
}

async function markUnknown(ctx: MessageOutboundDeps, message: { id: string; workspaceId: string; conversationId: string }, error: string): Promise<void> {
  const res = await ctx.db.message.updateMany({
    where: { id: message.id, status: { in: ["SENDING", "QUEUED"] } },
    data: { status: "UNKNOWN", payload: { error } },
  });
  if (res.count === 0) return;
  await ctx.bus.publish({
    workspaceId: message.workspaceId,
    type: "message.unknown",
    subject: `conversation:${message.conversationId}`,
    data: { messageId: message.id, error },
  });
}
