import type { Logger } from "pino";
import type { Db } from "../../data/db.js";
import { enqueueRun, type JobQueue } from "../../execution/queue/jobs.js";
import type { RunStore } from "./run-store.js";
import type { ConversationService } from "../../domain/conversations/service.js";

export interface SweepResult {
  recovered: number;
  requeued: number;
  resumed: number;
  failed: number;
}

/**
 * Barrido de runs huérfanos (M12). Se ejecuta cada minuto (job run.sweep).
 *
 * - RUNNING sin latido en `staleMs`: el worker murió a mitad. Se reencola con recover=true (retoma desde el checkpoint).
 * - QUEUED sin tomar en `staleMs`: el job se perdió o agotó reintentos (p. ej. RunBusyError). Se reencola.
 * - WAITING_APPROVAL sin aprobaciones PENDING: todas decididas pero la reanudación no llegó. Se reencola resume.
 *
 * `heartbeatAt` hace también de marca de "último reencolado", así un run no se reencola en cada pasada.
 * Tras `maxRecoveries` reencolados el run se marca FAILED para no entrar en bucle.
 */
export class RunSweeper {
  constructor(
    private readonly d: {
      db: Db;
      queue: JobQueue;
      runs: RunStore;
      log: Logger;
      staleMs?: number;
      maxRecoveries?: number;
      /** Si el run se da por perdido, los mensajes encolados detrás de él no se quedan huérfanos (D1). */
      conversations?: Pick<ConversationService, "releaseQueued">;
    },
  ) {}

  async sweep(now = new Date()): Promise<SweepResult> {
    const staleMs = this.d.staleMs ?? 10 * 60_000;
    const max = this.d.maxRecoveries ?? 3;
    const cutoff = new Date(now.getTime() - staleMs);
    const stale = { OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] };
    const result: SweepResult = { recovered: 0, requeued: 0, resumed: 0, failed: 0 };

    const candidates = await this.d.db.run.findMany({
      where: { status: { in: ["RUNNING", "QUEUED", "WAITING_APPROVAL"] }, ...stale },
      select: { id: true, workspaceId: true, conversationId: true, status: true, recoveries: true, heartbeatAt: true },
      take: 200,
    });

    for (const run of candidates) {
      if (run.status === "WAITING_APPROVAL") {
        const pending = await this.d.db.approval.count({ where: { workspaceId: run.workspaceId, runId: run.id, status: "PENDING" } });
        if (pending > 0) continue; // espera legítima a una persona
      }
      // Condicionado al estado y latido leídos: si otro proceso tocó el run entre medias, no se hace nada.
      const guard = { id: run.id, status: run.status, heartbeatAt: run.heartbeatAt, recoveries: run.recoveries };
      if (run.recoveries >= max) {
        const error = `Run abandonado: sin progreso tras ${max} reintentos automáticos`;
        const res = await this.d.db.run.updateMany({ where: guard, data: { status: "FAILED", error, finishedAt: now } });
        if (res.count === 1) {
          result.failed += 1;
          await this.d.runs.publish(run, "run.finished", { status: "FAILED", error });
          if (run.conversationId) await this.d.conversations?.releaseQueued(run.workspaceId, run.conversationId);
          this.d.log.warn({ runId: run.id, from: run.status }, "run huérfano marcado FAILED");
        }
        continue;
      }
      const res = await this.d.db.run.updateMany({ where: guard, data: { heartbeatAt: now, recoveries: { increment: 1 } } });
      if (res.count !== 1) continue;
      if (run.status === "RUNNING") {
        await enqueueRun(this.d.queue, run, "execute", { recover: true });
        result.recovered += 1;
      } else if (run.status === "QUEUED") {
        await enqueueRun(this.d.queue, run, "execute");
        result.requeued += 1;
      } else {
        await enqueueRun(this.d.queue, run, "resume");
        result.resumed += 1;
      }
      this.d.log.warn({ runId: run.id, from: run.status, attempt: run.recoveries + 1 }, "run huérfano reencolado");
    }
    return result;
  }
}
