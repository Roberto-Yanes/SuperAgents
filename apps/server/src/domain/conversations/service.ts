import type { Db } from "../../data/db.js";
import type { EventBus } from "../../execution/events/bus.js";
import { enqueueRun, JOBS, type JobQueue } from "../../execution/queue/jobs.js";
import { conflict, invalid, notFound } from "../../shared/errors.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import type { ConversationStatus } from "../../data/generated/prisma/enums.js";
import { audit, type Actor } from "../../data/audit.js";
import type { MessageAuthor } from "../../data/generated/prisma/enums.js";

export interface InboundInput {
  workspaceId: string;
  conversationId: string;
  text: string;
  author: MessageAuthor;
  channelMessageId?: string;
  trigger: string;
}

export type InboundResult =
  | { status: "run_queued"; messageId: string; runId: string }
  | { status: "duplicate"; messageId: string | null }
  | { status: "human_handling"; messageId: string }
  /** Hay un run esperando aprobación: el mensaje se guarda y no se llama al modelo. */
  | { status: "queued_behind_approval"; messageId: string }
  /** Ya hay un run QUEUED o RUNNING: este mensaje lo verá ese run (o el que se abra al terminar). */
  | { status: "coalesced"; messageId: string };

export class ConversationService {
  constructor(private readonly d: { db: Db; bus: EventBus; queue: JobQueue }) {}

  /** Conversación del canal "api" (chat desde la UI o una integración). */
  async createApiChat(workspaceId: string, agentId: string) {
    const agent = await this.d.db.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } });
    if (!agent) throw notFound("Agente");
    return this.d.db.conversation.create({ data: { workspaceId, agentId, channel: "api" } });
  }

  async listMessages(workspaceId: string, conversationId: string, limit = 200) {
    const chat = await this.d.db.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { id: true } });
    if (!chat) throw notFound("Conversación");
    return this.d.db.message.findMany({ where: { workspaceId, conversationId }, orderBy: { createdAt: "asc" }, take: limit });
  }

  async exists(workspaceId: string, conversationId: string): Promise<boolean> {
    return Boolean(await this.d.db.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { id: true } }));
  }

  /**
   * Punto único de entrada de mensajes (UI vía API y canales vía channel.inbound):
   * guarda el mensaje (deduplicado por channelMessageId) y respeta el takeover humano.
   *
   * D1 + N1: si la conversación tiene un run WAITING_APPROVAL, QUEUED o RUNNING, el mensaje se guarda
   * y no se crea otro run (así dos mensajes seguidos no producen dos respuestas ni el agente se contesta).
   * Al terminar el run en curso, releaseQueued abre un único run con lo que haya quedado sin reclamar.
   */
  async receive(input: InboundInput): Promise<InboundResult> {
    const { db, bus, queue } = this.d;
    const conversation = await db.conversation.findFirst({ where: { id: input.conversationId, workspaceId: input.workspaceId }, include: { agent: true } });
    if (!conversation) throw notFound("Conversación");
    if (conversation.status === "CLOSED") throw conflict("conversation_closed", "La conversación está cerrada");

    if (input.channelMessageId) {
      const dup = await db.message.findFirst({
        where: { workspaceId: input.workspaceId, conversationId: conversation.id, channelMessageId: input.channelMessageId },
        select: { id: true },
      });
      if (dup) return { status: "duplicate", messageId: dup.id };
    }

    const result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conv:${conversation.id}`}, 0))`;
      const fresh = await tx.conversation.findFirst({
        where: { id: conversation.id, workspaceId: input.workspaceId },
        include: { agent: true },
      });
      if (!fresh) throw notFound("Conversación");
      const message = await tx.message.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: fresh.id,
          direction: "INBOUND",
          author: input.author,
          text: input.text,
          channelMessageId: input.channelMessageId ?? null,
          status: "RECEIVED",
        },
      });
      await tx.conversation.update({ where: { id: fresh.id }, data: { lastInboundAt: new Date() } });
      const humanHandling = Boolean(fresh.takenOverBy) || fresh.status === "HANDOFF" || fresh.agent.status !== "ACTIVE";
      if (humanHandling) return { message, run: null, hold: "human" as const };
      const active = await tx.run.findFirst({
        where: { workspaceId: input.workspaceId, conversationId: fresh.id, status: { in: ["QUEUED", "RUNNING", "WAITING_APPROVAL"] } },
        select: { status: true },
      });
      if (active?.status === "WAITING_APPROVAL") return { message, run: null, hold: "approval" as const };
      if (active) return { message, run: null, hold: "coalesced" as const };
      const run = await tx.run.create({
        data: {
          workspaceId: input.workspaceId,
          agentId: fresh.agentId,
          agentVersion: fresh.agent.version,
          conversationId: fresh.id,
          trigger: input.trigger,
          input: { messageId: message.id },
        },
      });
      await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
      return { message, run, hold: null };
    });

    await bus.publish({
      workspaceId: input.workspaceId,
      type: "message.created",
      subject: `conversation:${conversation.id}`,
      data: { messageId: result.message.id, direction: "INBOUND", text: input.text, runId: result.run?.id ?? null },
    });
    // El contacto respondió: se detienen las secuencias de seguimiento que lo pidan.
    if (input.author === "CONTACT") await this.stopSequences(input.workspaceId, conversation.id, "contact_replied", true);

    if (result.hold === "human") return { status: "human_handling", messageId: result.message.id };
    if (result.hold === "approval") return { status: "queued_behind_approval", messageId: result.message.id };
    if (result.hold === "coalesced") return { status: "coalesced", messageId: result.message.id };
    await enqueueRun(queue, result.run!, "execute");
    return { status: "run_queued", messageId: result.message.id, runId: result.run!.id };
  }

  /**
   * Tras un run terminal: si no queda ninguno activo y hay entrantes sin reclamar, abre UN run.
   * Cubre la cola de D1 (mensajes llegados durante WAITING_APPROVAL) y el rechazo, la caducidad y el fallo del sweeper.
   * No hace nada en HANDOFF ni si el agente no está activo.
   */
  async releaseQueued(workspaceId: string, conversationId: string): Promise<{ runId: string } | null> {
    const run = await this.d.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conv:${conversationId}`}, 0))`;
      const active = await tx.run.count({
        where: { workspaceId, conversationId, status: { in: ["QUEUED", "RUNNING", "WAITING_APPROVAL"] } },
      });
      if (active > 0) return null;
      const conv = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId }, include: { agent: true } });
      if (!conv || conv.status !== "OPEN" || conv.takenOverBy || conv.agent.status !== "ACTIVE") return null;
      const pending = await tx.message.findFirst({
        where: { workspaceId, conversationId, direction: "INBOUND", runId: null },
        select: { id: true },
      });
      if (!pending) return null;
      return tx.run.create({
        data: {
          workspaceId,
          agentId: conv.agentId,
          agentVersion: conv.agent.version,
          conversationId,
          trigger: "queued.release",
          input: { messageId: pending.id },
        },
      });
    });
    if (!run) return null;
    await enqueueRun(this.d.queue, run, "execute");
    return { runId: run.id };
  }

  // ───────────── Inbox y takeover ─────────────

  inbox(workspaceId: string, q: { status?: ConversationStatus; channel?: string; agentId?: string; takenOver?: boolean; limit?: number; cursor?: string }) {
    const where: Prisma.ConversationWhereInput = { workspaceId };
    if (q.status) where.status = q.status;
    if (q.channel) where.channel = q.channel;
    if (q.agentId) where.agentId = q.agentId;
    if (q.takenOver !== undefined) where.takenOverBy = q.takenOver ? { not: null } : null;
    return this.d.db.conversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: Math.min(q.limit ?? 50, 200),
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { contact: { select: { id: true, name: true, phone: true, email: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
  }

  async get(workspaceId: string, conversationId: string) {
    const conv = await this.d.db.conversation.findFirst({ where: { id: conversationId, workspaceId } });
    if (!conv) throw notFound("Conversación");
    return conv;
  }

  /** Una persona toma la conversación: el agente deja de responder y se paran las secuencias. */
  async takeover(workspaceId: string, conversationId: string, userId: string, actor: Actor) {
    await this.get(workspaceId, conversationId);
    const conv = await this.d.db.conversation.update({ where: { id: conversationId }, data: { takenOverBy: userId, status: "HANDOFF" } });
    await this.stopSequences(workspaceId, conversationId, "human_takeover", false);
    await this.d.bus.publish({ workspaceId, type: "conversation.taken_over", subject: `conversation:${conversationId}`, data: { by: userId } });
    await audit(this.d.db, { workspaceId, actor, action: "conversation.takeover", target: `conversation:${conversationId}` });
    return conv;
  }

  /** Devuelve la conversación al agente. */
  async release(workspaceId: string, conversationId: string, actor: Actor) {
    await this.get(workspaceId, conversationId);
    const conv = await this.d.db.conversation.update({ where: { id: conversationId }, data: { takenOverBy: null, status: "OPEN" } });
    await this.d.bus.publish({ workspaceId, type: "conversation.released", subject: `conversation:${conversationId}`, data: {} });
    await audit(this.d.db, { workspaceId, actor, action: "conversation.release", target: `conversation:${conversationId}` });
    return conv;
  }

  /** Respuesta de una persona del equipo: sale por el outbox del canal (o por eventos en "api"). */
  async replyAsHuman(workspaceId: string, conversationId: string, text: string, userId: string) {
    const conv = await this.get(workspaceId, conversationId);
    if (conv.status === "CLOSED") throw conflict("conversation_closed", "La conversación está cerrada");
    if (!conv.takenOverBy) throw invalid("not_taken_over", "Toma la conversación antes de responder como persona");
    return this.sendOutbound(conv, text, "HUMAN", { userId });
  }

  /** Mensaje saliente (agente, persona o sistema): outbox + evento. Base de respuestas, secuencias y recordatorios. */
  async sendOutbound(
    conv: { id: string; workspaceId: string; connectionId: string | null },
    text: string,
    author: "AGENT" | "HUMAN" | "SYSTEM",
    meta: Record<string, unknown> = {},
  ) {
    const external = conv.connectionId !== null;
    const message = await this.d.db.message.create({
      data: {
        workspaceId: conv.workspaceId,
        conversationId: conv.id,
        direction: "OUTBOUND",
        author,
        text,
        status: external ? "QUEUED" : "SENT",
        payload: meta as Prisma.InputJsonValue,
      },
    });
    await this.d.bus.publish({
      workspaceId: conv.workspaceId,
      type: "message.created",
      subject: `conversation:${conv.id}`,
      data: { messageId: message.id, direction: "OUTBOUND", author, text },
    });
    if (external) await this.d.queue.send(JOBS.messageOutbound, { workspaceId: conv.workspaceId, messageId: message.id });
    return message;
  }

  async setStatus(workspaceId: string, conversationId: string, status: "OPEN" | "CLOSED", actor: Actor) {
    await this.get(workspaceId, conversationId);
    const conv = await this.d.db.conversation.update({
      where: { id: conversationId },
      data: { status, ...(status === "CLOSED" ? { takenOverBy: null } : {}) },
    });
    if (status === "CLOSED") await this.stopSequences(workspaceId, conversationId, "conversation_closed", false);
    await this.d.bus.publish({
      workspaceId,
      type: `conversation.${status === "CLOSED" ? "closed" : "reopened"}`,
      subject: `conversation:${conversationId}`,
      data: {},
    });
    await audit(this.d.db, { workspaceId, actor, action: `conversation.${status.toLowerCase()}`, target: `conversation:${conversationId}` });
    return conv;
  }

  private async stopSequences(workspaceId: string, conversationId: string, reason: string, onlyStopOnReply: boolean): Promise<void> {
    await this.d.db.sequenceEnrollment.updateMany({
      where: { workspaceId, conversationId, status: "ACTIVE", ...(onlyStopOnReply ? { sequence: { stopOnReply: true } } : {}) },
      data: { status: "STOPPED", stoppedReason: reason, nextRunAt: null },
    });
  }

  /** Estado de entrega de un mensaje saliente, por su id en el canal (webhooks de estado). */
  async markDelivery(workspaceId: string, channelMessageId: string, status: "SENT" | "DELIVERED" | "READ" | "FAILED"): Promise<void> {
    await this.d.db.message.updateMany({ where: { workspaceId, channelMessageId, direction: "OUTBOUND" }, data: { status } });
  }
}
