import type { ModelMessage } from "ai";
import { Prisma, type Db } from "../../data/db.js";
import { estimateCostUsd } from "../../shared/observability/cost.js";
import { runsFinished } from "../../shared/observability/metrics.js";
import type { RunStatus } from "../../data/generated/prisma/enums.js";
import type { EventBus } from "../../execution/events/bus.js";

/** Antigüedad mínima del latido para recuperar un run RUNNING (ver reclaim). */
export const RECLAIM_MIN_AGE_MS = 2_000;

/** Otro run de la misma conversación está en curso: el job se reintenta más tarde. */
export class RunBusyError extends Error {
  readonly retryable = true;
  constructor(
    readonly runId: string,
    readonly conversationId: string,
  ) {
    super(`La conversación ${conversationId} tiene otro run en curso`);
    this.name = "RunBusyError";
  }
}

export type RunWithAgent = Prisma.RunGetPayload<{ include: { agent: true; conversation: true } }>;
export type FinalStatus = "SUCCEEDED" | "FAILED" | "CANCELLED" | "BLOCKED";

/** Persistencia y ciclo de vida de un run: carga, toma atómica, checkpoint y cierre. */
export class RunStore {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  load(workspaceId: string, runId: string): Promise<RunWithAgent | null> {
    return this.db.run.findFirst({ where: { id: runId, workspaceId }, include: { agent: true, conversation: true } });
  }

  /**
   * Transición condicionada: solo un worker gana. Devuelve true si este proceso tomó el run.
   * Defensa en profundidad para H1 (además del grupo pg-boss): bajo un advisory lock por conversación,
   * no se toma si otro run de la misma conversación está RUNNING; en ese caso lanza RunBusyError (reintentable).
   */
  async claim(workspaceId: string, runId: string, from: RunStatus): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const run = await tx.run.findFirst({ where: { id: runId, workspaceId }, select: { conversationId: true } });
      if (!run) return false;
      if (run.conversationId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conv:${run.conversationId}`}, 0))`;
        const busy = await tx.run.count({
          where: { workspaceId, conversationId: run.conversationId, status: "RUNNING", id: { not: runId } },
        });
        if (busy > 0) {
          const still = await tx.run.count({ where: { id: runId, workspaceId, status: from } });
          if (still > 0) throw new RunBusyError(runId, run.conversationId);
          return false;
        }
      }
      const now = new Date();
      const res = await tx.run.updateMany({
        where: { id: runId, workspaceId, status: from },
        data: { status: "RUNNING", heartbeatAt: now, ...(from === "QUEUED" ? { startedAt: now } : {}) },
      });
      return res.count === 1;
    });
  }

  /**
   * Recuperación de un run RUNNING cuyo worker murió: compare-and-set sobre el latido leído.
   * Si dos procesos intentan recuperarlo a la vez (reintento de pg-boss + barrido), solo uno gana.
   */
  async reclaim(run: { id: string; workspaceId: string; heartbeatAt: Date | null }): Promise<boolean> {
    // El latido leído tiene que ser viejo: si es de hace instantes, otro proceso acaba de reclamarlo (y quien lo leyó
    // después de ese reclamo vería un valor "igual" y ganaría también). El barrido deja su marca RECLAIM_MIN_AGE_MS atrás.
    if (run.heartbeatAt && Date.now() - run.heartbeatAt.getTime() < RECLAIM_MIN_AGE_MS) return false;
    const res = await this.db.run.updateMany({
      where: { id: run.id, workspaceId: run.workspaceId, status: "RUNNING", heartbeatAt: run.heartbeatAt },
      data: { heartbeatAt: new Date() },
    });
    return res.count === 1;
  }

  checkpoint(runId: string, messages: ModelMessage[], stepCount: number): Promise<unknown> {
    return this.db.run.update({ where: { id: runId }, data: { checkpoint: toJson(messages), stepCount, heartbeatAt: new Date() } });
  }

  async isCancelled(workspaceId: string, runId: string): Promise<boolean> {
    return (await this.db.run.count({ where: { id: runId, workspaceId, status: "CANCELLED" } })) > 0;
  }

  /** Latido sin checkpoint (pasos largos del modelo). */
  heartbeat(workspaceId: string, runId: string): Promise<unknown> {
    return this.db.run.updateMany({ where: { id: runId, workspaceId, status: "RUNNING" }, data: { heartbeatAt: new Date() } });
  }

  async finish(
    run: RunWithAgent,
    status: FinalStatus,
    extra: { output?: string; error?: string; checkpoint?: ModelMessage[]; usage?: unknown } = {},
  ): Promise<boolean> {
    // Condicionado: un run ya cerrado (p. ej. cancelado por una persona) no se reescribe.
    const res = await this.db.run.updateMany({
      where: { id: run.id, workspaceId: run.workspaceId, status: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"] } },
      data: {
        status,
        finishedAt: new Date(),
        output: extra.output ?? null,
        error: extra.error ?? null,
        ...(extra.checkpoint ? { checkpoint: toJson(extra.checkpoint) } : {}),
        ...(extra.usage
          ? { usage: mergeUsage(run.usage, extra.usage), costUsd: new Prisma.Decimal(run.costUsd.toString()).plus(estimateCostUsd(extra.usage)) }
          : {}),
      },
    });
    if (res.count === 0) return false;
    runsFinished.inc({ status });
    await this.bus.publish({
      workspaceId: run.workspaceId,
      type: "run.finished",
      subject: `run:${run.id}`,
      data: { status, ...(extra.error ? { error: extra.error } : {}) },
    });
    return true;
  }

  publish(run: { id: string; workspaceId: string }, type: string, data: Prisma.InputJsonValue = {}) {
    return this.bus.publish({ workspaceId: run.workspaceId, type, subject: `run:${run.id}`, data });
  }
}

/**
 * Registro de pasos (RunStep) con índice monotónico por run.
 * Contador en memoria: las tools de un mismo paso se ejecutan en paralelo y no deben competir por el índice.
 */
export class StepRecorder {
  private next = 0;

  private constructor(
    private readonly db: Db,
    private readonly run: { id: string; workspaceId: string },
  ) {}

  static async for(db: Db, run: { id: string; workspaceId: string }): Promise<StepRecorder> {
    const recorder = new StepRecorder(db, run);
    const last = await db.runStep.findFirst({ where: { workspaceId: run.workspaceId, runId: run.id }, orderBy: { index: "desc" }, select: { index: true } });
    recorder.next = (last?.index ?? -1) + 1;
    return recorder;
  }

  /** Llamada con efectos ya registrada en este run (misma huella) y su resultado, si llegó a guardarse. */
  async findByDedupeKey(dedupeKey: string): Promise<{ toolCallId: string | null; output: unknown; hasResult: boolean } | null> {
    const call = await this.db.runStep.findUnique({ where: { runId_dedupeKey: { runId: this.run.id, dedupeKey } } });
    if (!call) return null;
    const result = call.toolCallId
      ? await this.db.runStep.findFirst({
          where: { workspaceId: this.run.workspaceId, runId: this.run.id, kind: "tool_result", toolCallId: call.toolCallId },
          orderBy: { index: "desc" },
        })
      : null;
    return { toolCallId: call.toolCallId, output: (result?.data as { output?: unknown } | undefined)?.output, hasResult: Boolean(result) };
  }

  async record(
    kind: "llm" | "tool_call" | "tool_result" | "note",
    s: { toolName?: string; toolCallId?: string; dedupeKey?: string; data?: unknown } = {},
  ): Promise<void> {
    const index = this.next++;
    await this.db.runStep.create({
      data: {
        workspaceId: this.run.workspaceId,
        runId: this.run.id,
        index,
        kind,
        toolName: s.toolName ?? null,
        toolCallId: s.toolCallId ?? null,
        dedupeKey: s.dedupeKey ?? null,
        data: (s.data ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}

export function toJson(messages: ModelMessage[]): Prisma.InputJsonValue {
  return messages as unknown as Prisma.InputJsonValue;
}

export function fromJson(value: Prisma.JsonValue): ModelMessage[] {
  return Array.isArray(value) ? (value as unknown as ModelMessage[]) : [];
}

export function mergeUsage(previous: unknown, next: unknown): Prisma.InputJsonValue {
  const a = (previous ?? {}) as Record<string, unknown>;
  const b = (next ?? {}) as Record<string, unknown>;
  const sum = (k: string) => (Number(a[k] ?? 0) || 0) + (Number(b[k] ?? 0) || 0);
  return { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens") };
}
