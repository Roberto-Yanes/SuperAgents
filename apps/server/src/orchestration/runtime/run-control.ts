import type { Db } from "../../data/db.js";
import { audit, type Actor } from "../../data/audit.js";
import { conflict, notFound } from "../../shared/errors.js";
import type { RunStore } from "./run-store.js";

/**
 * Acciones de una persona sobre un run en curso.
 * cancel(): QUEUED, RUNNING o WAITING_APPROVAL → CANCELLED. El runtime lo detecta tras cada paso del modelo
 * (aborta y no entrega respuesta) y las aprobaciones pendientes quedan rechazadas.
 */
export class RunControl {
  constructor(private readonly d: { db: Db; runs: RunStore }) {}

  async cancel(workspaceId: string, runId: string, actor: Actor, reason = "Cancelado por una persona"): Promise<void> {
    const run = await this.d.db.run.findFirst({ where: { id: runId, workspaceId }, select: { id: true, workspaceId: true, status: true } });
    if (!run) throw notFound("Run");
    const res = await this.d.db.$transaction(async (tx) => {
      const r = await tx.run.updateMany({
        where: { id: runId, workspaceId, status: { in: ["QUEUED", "RUNNING", "WAITING_APPROVAL"] } },
        data: { status: "CANCELLED", error: reason, finishedAt: new Date() },
      });
      if (r.count === 1) {
        await tx.approval.updateMany({
          where: { runId, status: { in: ["PENDING", "APPROVED"] } },
          data: { status: "REJECTED", reason: "Run cancelado", decidedAt: new Date(), decidedBy: actor.id },
        });
      }
      return r.count;
    });
    if (res === 0) throw conflict("run_not_cancellable", `El run ya terminó (${run.status})`);
    await this.d.runs.publish(run, "run.finished", { status: "CANCELLED", error: reason });
    await audit(this.d.db, { workspaceId, actor, action: "run.cancelled", target: `run:${runId}` });
  }
}
