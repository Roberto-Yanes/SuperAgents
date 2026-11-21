import type { Db } from "../../data/db.js";
import type { EventBus } from "../../execution/events/bus.js";
import { JOBS, type JobQueue } from "../../execution/queue/jobs.js";
import type { RunWithAgent } from "./run-store.js";

/**
 * Entrega de la respuesta final (paso 5 del diagrama): mensaje saliente en el outbox.
 * Canal "api": la UI ya la recibe por eventos. Resto de canales: job message.outbound.
 */
export class ReplyDelivery {
  constructor(private readonly d: { db: Db; bus: EventBus; queue: JobQueue }) {}

  async deliver(run: RunWithAgent, text: string): Promise<void> {
    if (!run.conversation || !text) return;
    const external = run.conversation.connectionId !== null;
    // Idempotente por run (H4): si el worker cae tras entregar y antes de cerrar el run, el reintento no duplica la respuesta.
    const idempotencyKey = `reply:${run.id}`;
    const existing = await this.d.db.message.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: run.workspaceId, idempotencyKey } } });
    if (existing) {
      if (existing.status === "QUEUED") await this.d.queue.send(JOBS.messageOutbound, { workspaceId: run.workspaceId, messageId: existing.id });
      return;
    }
    const message = await this.d.db.message.create({
      data: {
        workspaceId: run.workspaceId,
        conversationId: run.conversation.id,
        direction: "OUTBOUND",
        author: "AGENT",
        text,
        runId: run.id,
        idempotencyKey,
        status: external ? "QUEUED" : "SENT",
      },
    });
    const data = { messageId: message.id, runId: run.id, text };
    await this.d.bus.publish({ workspaceId: run.workspaceId, type: "message.completed", subject: `run:${run.id}`, data });
    await this.d.bus.publish({ workspaceId: run.workspaceId, type: "message.created", subject: `conversation:${run.conversation.id}`, data });
    if (external) await this.d.queue.send(JOBS.messageOutbound, { workspaceId: run.workspaceId, messageId: message.id });
  }
}
