import { z } from "zod";

/** Cupo de una tarea (ADR 003, E3). Todos cortan ANTES de la próxima llamada al modelo. */
export interface TaskLimits {
  /** Llamadas al modelo + llamadas a tools. */
  maxSteps: number;
  /** Suma de Run.costUsd de los tramos (tarifa de referencia) más lo gastado por las hijas. */
  maxCostUsd: number;
  /** Tiempo de pared. Con pauseClockOnWait, las esperas (aprobación, dato externo, hija) no cuentan. */
  maxDurationMs: number;
  pauseClockOnWait: boolean;
}

export type TaskSourceKind = "APP" | "CHANNEL" | "ROUTINE" | "DELEGATION";

/** Techo de la plataforma: ni el tenant ni el dueño lo superan. */
export const PLATFORM_LIMITS: TaskLimits = { maxSteps: 200, maxCostUsd: 25, maxDurationMs: 7 * 24 * 3_600_000, pauseClockOnWait: true };

/** Defaults por puerta: una tarea de canal es corta; una de la app puede investigar. */
export const DEFAULT_LIMITS: Record<TaskSourceKind, TaskLimits> = {
  CHANNEL: { maxSteps: 12, maxCostUsd: 0.25, maxDurationMs: 10 * 60_000, pauseClockOnWait: true },
  APP: { maxSteps: 40, maxCostUsd: 2, maxDurationMs: 2 * 3_600_000, pauseClockOnWait: true },
  ROUTINE: { maxSteps: 30, maxCostUsd: 1, maxDurationMs: 3_600_000, pauseClockOnWait: true },
  DELEGATION: { maxSteps: 30, maxCostUsd: 1, maxDurationMs: 3_600_000, pauseClockOnWait: true },
};

export const TaskLimitsPatch = z
  .object({
    maxSteps: z.number().int().min(1).max(PLATFORM_LIMITS.maxSteps).optional(),
    maxCostUsd: z.number().positive().max(PLATFORM_LIMITS.maxCostUsd).optional(),
    maxDurationMs: z.number().int().min(10_000).max(PLATFORM_LIMITS.maxDurationMs).optional(),
    pauseClockOnWait: z.boolean().optional(),
  })
  .strict();
export type TaskLimitsInput = z.infer<typeof TaskLimitsPatch>;

/**
 * Cupo efectivo: default de la puerta ← lo que pida quien la lanza, sin pasar el techo del tenant ni el de la plataforma.
 * `ceiling` = cupo del tenant (taskLimits) acotado por la plataforma.
 */
export function resolveLimits(source: TaskSourceKind, requested: TaskLimitsInput | undefined, tenant: TaskLimitsInput | undefined): TaskLimits {
  const base = DEFAULT_LIMITS[source];
  const ceiling: TaskLimits = {
    maxSteps: Math.min(PLATFORM_LIMITS.maxSteps, tenant?.maxSteps ?? PLATFORM_LIMITS.maxSteps),
    maxCostUsd: Math.min(PLATFORM_LIMITS.maxCostUsd, tenant?.maxCostUsd ?? PLATFORM_LIMITS.maxCostUsd),
    maxDurationMs: Math.min(PLATFORM_LIMITS.maxDurationMs, tenant?.maxDurationMs ?? PLATFORM_LIMITS.maxDurationMs),
    pauseClockOnWait: true,
  };
  return {
    maxSteps: Math.min(requested?.maxSteps ?? Math.min(base.maxSteps, ceiling.maxSteps), ceiling.maxSteps),
    maxCostUsd: Math.min(requested?.maxCostUsd ?? Math.min(base.maxCostUsd, ceiling.maxCostUsd), ceiling.maxCostUsd),
    maxDurationMs: Math.min(requested?.maxDurationMs ?? Math.min(base.maxDurationMs, ceiling.maxDurationMs), ceiling.maxDurationMs),
    pauseClockOnWait: requested?.pauseClockOnWait ?? tenant?.pauseClockOnWait ?? base.pauseClockOnWait,
  };
}

export function limitsOf(raw: unknown): TaskLimits {
  const l = (raw ?? {}) as Partial<TaskLimits>;
  return {
    maxSteps: l.maxSteps ?? DEFAULT_LIMITS.APP.maxSteps,
    maxCostUsd: l.maxCostUsd ?? DEFAULT_LIMITS.APP.maxCostUsd,
    maxDurationMs: l.maxDurationMs ?? DEFAULT_LIMITS.APP.maxDurationMs,
    pauseClockOnWait: l.pauseClockOnWait ?? true,
  };
}

export type BlockReason = "steps" | "cost" | "time" | "model_region";

/** Tiempo consumido: con el reloj pausado en esperas, la suma de tramos; si no, pared desde el inicio. */
export function timeUsedMs(task: { limits: unknown; elapsedMs: number; segmentStartedAt: Date | null; startedAt: Date }, now = new Date()): number {
  if (!limitsOf(task.limits).pauseClockOnWait) return now.getTime() - task.startedAt.getTime();
  return task.elapsedMs + (task.segmentStartedAt ? now.getTime() - task.segmentStartedAt.getTime() : 0);
}

/** Primer cupo agotado, o null. `extra` = lo gastado en el tramo en curso y aún no persistido. */
export function exhausted(
  task: {
    limits: unknown;
    spentSteps: number;
    spentCostUsd: { toString(): string } | number;
    elapsedMs: number;
    segmentStartedAt: Date | null;
    startedAt: Date;
  },
  extra: { steps?: number; costUsd?: number } = {},
  now = new Date(),
): BlockReason | null {
  const l = limitsOf(task.limits);
  if (task.spentSteps + (extra.steps ?? 0) >= l.maxSteps) return "steps";
  if (Number(task.spentCostUsd.toString()) + (extra.costUsd ?? 0) >= l.maxCostUsd) return "cost";
  if (timeUsedMs(task, now) >= l.maxDurationMs) return "time";
  return null;
}
