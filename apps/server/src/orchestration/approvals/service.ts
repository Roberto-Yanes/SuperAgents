import type { ApprovalStatus } from "../../data/generated/prisma/enums.js";
import type { Db } from "../../data/db.js";
import type { EventBus } from "../../execution/events/bus.js";
import { enqueueRun, type JobQueue } from "../../execution/queue/jobs.js";
import { conflict, notFound } from "../../shared/errors.js";
import { audit, type Actor } from "../../data/audit.js";

export class ApprovalService {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly queue: JobQueue,
  ) {}

  list(workspaceId: string, status?: ApprovalStatus) {
    return this.db.approval.findMany({ where: { workspaceId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
  }

  async get(workspaceId: string, id: string) {
    const approval = await this.db.approval.findFirst({ where: { id, workspaceId } });
    if (!approval) throw notFound("Aprobación");
    return approval;
  }

  /**
   * Aprueba o rechaza. La transición es atómica (solo desde PENDING y sin caducar): dos clics, una decisión.
   * Cuando el run no tiene más pendientes, se encola run.resume.
   */
  async decide(workspaceId: string, approvalId: string, decision: "APPROVED" | "REJECTED", actor: Actor, reason?: string) {
    const now = new Date();
    const updated = await this.db.approval.updateMany({
      where: { id: approvalId, workspaceId, status: "PENDING", expiresAt: { gt: now } },
      data: { status: decision, decidedBy: actor.id, decidedAt: now, reason: reason ?? null },
    });
    const approval = await this.db.approval.findFirst({ where: { id: approvalId, workspaceId } });
    if (!approval) throw notFound("Aprobación");
    if (updated.count === 0) {
      throw conflict("approval_not_pending", `La aprobación ya no está pendiente (estado: ${approval.status})`);
    }
    await audit(this.db, {
      workspaceId,
      actor,
      action: `approval.${decision.toLowerCase()}`,
      target: `approval:${approvalId}`,
      data: { runId: approval.runId, tool: approval.toolName },
    });
    await this.bus.publish({
      workspaceId,
      type: "approval.decided",
      subject: `run:${approval.runId}`,
      data: { approvalId, decision },
    });
    await this.resumeIfReady(workspaceId, approval.runId);
    return approval;
  }

  /** Caduca las pendientes vencidas y reanuda los runs afectados (el agente recibe "caducó"). */
  async expireDue(now = new Date()): Promise<number> {
    const due = await this.db.approval.findMany({
      where: { status: "PENDING", expiresAt: { lte: now } },
      select: { id: true, workspaceId: true, runId: true },
      take: 500,
    });
    if (due.length === 0) return 0;
    await this.db.approval.updateMany({
      where: { id: { in: due.map((d) => d.id) }, status: "PENDING" },
      data: { status: "EXPIRED", decidedAt: now },
    });
    const runs = new Map(due.map((d) => [d.runId, d.workspaceId]));
    for (const [runId, workspaceId] of runs) {
      await this.bus.publish({ workspaceId, type: "approval.expired", subject: `run:${runId}`, data: {} });
      await this.resumeIfReady(workspaceId, runId);
    }
    return due.length;
  }

  private async resumeIfReady(workspaceId: string, runId: string): Promise<void> {
    const pending = await this.db.approval.count({ where: { workspaceId, runId, status: "PENDING" } });
    if (pending > 0) return;
    const run = await this.db.run.findFirst({
      where: { id: runId, workspaceId, status: "WAITING_APPROVAL" },
      select: { id: true, workspaceId: true, conversationId: true },
    });
    if (run) await enqueueRun(this.queue, run, "resume");
  }
}
