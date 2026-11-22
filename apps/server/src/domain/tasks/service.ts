import { Prisma, type Db } from "../../data/db.js";
import type { Task } from "../../data/generated/prisma/client.js";
import type { TaskStatus } from "../../data/generated/prisma/enums.js";
import { audit, type Actor } from "../../data/audit.js";
import type { EventBus } from "../../execution/events/bus.js";
import { enqueueRun, type JobQueue } from "../../execution/queue/jobs.js";
import type { WaitPort } from "../../execution/queue/ports.js";
import { conflict, invalid, notFound } from "../../shared/errors.js";
import { exhausted, limitsOf, PLATFORM_LIMITS, resolveLimits, TaskLimitsPatch, type TaskLimitsInput } from "./limits.js";

export const TERMINAL_TASK: TaskStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];
const ACTIVE_RUN = ["QUEUED", "RUNNING", "WAITING_APPROVAL"] as const;
/** Profundidad máxima de delegación (ADR 003). */
export const MAX_TASK_DEPTH = 3;

export interface CreateTaskInput {
  agentId: string;
  goal: string;
  /** Datos de partida (p. ej. { leadId }). Se muestran al agente como referencia, no como instrucción. */
  context?: Record<string, unknown>;
  limits?: TaskLimitsInput;
}

/**
 * Tareas del runtime autónomo (ADR 003): la puerta de la app (POST /v1/tasks) y las operaciones del dueño.
 * El loop vive en orquestación (AgentRuntime + TaskStore); aquí solo se crean tareas, se consultan y se mueven
 * los estados que decide una persona (cancelar, ampliar cupo, mandar un dato).
 */
export class TaskService {
  constructor(private readonly d: { db: Db; bus: EventBus; queue: JobQueue; waits: WaitPort }) {}

  /** Tarea de la app: PLANNING + su primer tramo. El workspace sale del principal, nunca del cuerpo. */
  async create(workspaceId: string, input: CreateTaskInput, actor: Actor): Promise<Task> {
    const goal = input.goal.trim();
    if (!goal) throw invalid("goal_required", "El objetivo no puede estar vacío");
    const agent = await this.d.db.agent.findFirst({ where: { id: input.agentId, workspaceId } });
    if (!agent) throw notFound("Agente");
    if (agent.status !== "ACTIVE") throw conflict("agent_inactive", "El agente no está activo");
    await this.assertContext(workspaceId, input.context ?? {});
    const tenant = await this.tenantLimits(workspaceId);
    const { task, run } = await this.d.db.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          workspaceId,
          agentId: agent.id,
          goal,
          source: "APP",
          launchedBy: `${actor.type}:${actor.id ?? "system"}`,
          context: (input.context ?? {}) as Prisma.InputJsonValue,
          limits: resolveLimits("APP", input.limits, tenant) as unknown as Prisma.InputJsonValue,
        },
      });
      const run = await tx.run.create({
        data: { workspaceId, agentId: agent.id, agentVersion: agent.version, taskId: task.id, trigger: "task", input: { taskId: task.id } },
      });
      return { task, run };
    });
    await this.publish(task, "task.created", { status: task.status, goal: task.goal, source: task.source, runId: run.id });
    await audit(this.d.db, { workspaceId, actor, action: "task.created", target: `task:${task.id}`, data: { agentId: agent.id, source: "APP" } });
    await enqueueRun(this.d.queue, run, "execute");
    return task;
  }

  list(workspaceId: string, q: { status?: TaskStatus; agentId?: string; source?: Task["source"]; parentTaskId?: string; cursor?: string; limit?: number }) {
    const take = Math.min(q.limit ?? 50, 100);
    return this.d.db.task
      .findMany({
        where: {
          workspaceId,
          ...(q.status ? { status: q.status } : {}),
          ...(q.agentId ? { agentId: q.agentId } : {}),
          ...(q.source ? { source: q.source } : {}),
          ...(q.parentTaskId ? { parentTaskId: q.parentTaskId } : {}),
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: take + 1,
      })
      .then((rows) => ({ data: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null }));
  }

  async get(workspaceId: string, id: string) {
    const task = await this.d.db.task.findFirst({
      where: { id, workspaceId },
      include: {
        runs: {
          orderBy: { createdAt: "asc" },
          select: { id: true, status: true, trigger: true, stepCount: true, costUsd: true, createdAt: true, finishedAt: true, error: true },
        },
        children: { select: { id: true, status: true, goal: true } },
      },
    });
    if (!task) throw notFound("Tarea");
    return task;
  }

  async exists(workspaceId: string, id: string): Promise<boolean> {
    return (await this.d.db.task.count({ where: { id, workspaceId } })) > 0;
  }

  /**
   * Cancelar: la tarea, sus tramos activos (las aprobaciones pendientes quedan rechazadas y nada en espera se envía)
   * y sus hijas. El runtime lo detecta tras el paso en curso y no vuelve a llamar al modelo.
   */
  async cancel(workspaceId: string, id: string, actor: Actor, reason = "Cancelada por una persona"): Promise<void> {
    const task = await this.d.db.task.findFirst({ where: { id, workspaceId } });
    if (!task) throw notFound("Tarea");
    if (TERMINAL_TASK.includes(task.status)) throw conflict("task_not_cancellable", `La tarea ya terminó (${task.status})`);
    const tree = await this.descendants(workspaceId, id);
    const ids = [id, ...tree];
    const now = new Date();
    const cancelledRuns = await this.d.db.$transaction(async (tx) => {
      const tasks = await tx.task.findMany({ where: { workspaceId, id: { in: ids }, status: { notIn: TERMINAL_TASK } } });
      for (const t of tasks) {
        await tx.task.updateMany({
          where: { id: t.id, workspaceId, status: { notIn: TERMINAL_TASK } },
          data: { status: "CANCELLED", error: reason, finishedAt: now, waiting: Prisma.DbNull, ...closeClock(t, now) },
        });
      }
      const runs = await tx.run.findMany({
        where: { workspaceId, taskId: { in: ids }, status: { in: [...ACTIVE_RUN] } },
        select: { id: true, workspaceId: true },
      });
      await tx.run.updateMany({ where: { workspaceId, id: { in: runs.map((r) => r.id) } }, data: { status: "CANCELLED", error: reason, finishedAt: now } });
      await tx.approval.updateMany({
        where: { workspaceId, runId: { in: runs.map((r) => r.id) }, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "REJECTED", reason: "Tarea cancelada", decidedAt: now, decidedBy: actor.id },
      });
      return runs;
    });
    for (const r of cancelledRuns) {
      await this.d.bus.publish({ workspaceId, type: "run.finished", subject: `run:${r.id}`, data: { status: "CANCELLED", error: reason } });
    }
    for (const tid of ids) await this.publish({ id: tid, workspaceId }, "task.finished", { status: "CANCELLED", error: reason });
    await audit(this.d.db, { workspaceId, actor, action: "task.cancelled", target: `task:${id}`, data: { cascade: tree.length } });
    if (task.parentTaskId) await this.d.waits.wakeOnSignal({ workspaceId, id: task.parentTaskId }, "child");
  }

  /**
   * Ampliar el cupo (BLOCKED → sigue desde el checkpoint). No supera el techo de la plataforma.
   * Un bloqueo por política de modelos (model_region) no se arregla con cupo.
   */
  async extendLimits(workspaceId: string, id: string, patch: unknown, actor: Actor): Promise<Task> {
    const parsed = TaskLimitsPatch.safeParse(patch);
    if (!parsed.success) throw invalid("task_limits_invalid", "Cupo inválido", parsed.error.issues);
    const task = await this.d.db.task.findFirst({ where: { id, workspaceId } });
    if (!task) throw notFound("Tarea");
    if (TERMINAL_TASK.includes(task.status)) throw conflict("task_finished", "La tarea ya terminó");
    const prev = limitsOf(task.limits);
    const next = {
      maxSteps: Math.min(PLATFORM_LIMITS.maxSteps, parsed.data.maxSteps ?? prev.maxSteps),
      maxCostUsd: Math.min(PLATFORM_LIMITS.maxCostUsd, parsed.data.maxCostUsd ?? prev.maxCostUsd),
      maxDurationMs: Math.min(PLATFORM_LIMITS.maxDurationMs, parsed.data.maxDurationMs ?? prev.maxDurationMs),
      pauseClockOnWait: parsed.data.pauseClockOnWait ?? prev.pauseClockOnWait,
    };
    const updated = await this.d.db.task.update({ where: { id: task.id }, data: { limits: next as unknown as Prisma.InputJsonValue } });
    await audit(this.d.db, { workspaceId, actor, action: "task.limits_extended", target: `task:${id}`, data: { from: { ...prev }, to: next } });
    await this.publish(task, "task.limits", { limits: next });
    if (task.status === "BLOCKED" && task.blockedReason !== "model_region") {
      if (exhausted(updated)) throw conflict("limits_still_exhausted", "El cupo nuevo sigue agotado: amplíalo por encima de lo gastado");
      await this.d.waits.wakeOnSignal({ workspaceId, id }, "limits");
    }
    return updated;
  }

  /** Dato del dueño para una tarea en WAITING_EXTERNAL: se guarda y la tarea despierta con él. */
  async signal(workspaceId: string, id: string, message: string, actor: Actor): Promise<void> {
    const text = message.trim();
    if (!text) throw invalid("message_required", "El mensaje no puede estar vacío");
    const updated = await this.d.db.$transaction(async (tx) => {
      const task = await tx.task.findFirst({ where: { id, workspaceId } });
      if (!task) throw notFound("Tarea");
      if (task.status !== "WAITING_EXTERNAL") throw conflict("task_not_waiting", `La tarea no espera un dato (${task.status})`);
      const waiting = (task.waiting ?? {}) as { inbox?: Array<{ at: string; text: string; by: string }> };
      const inbox = [...(waiting.inbox ?? []), { at: new Date().toISOString(), text: text.slice(0, 4_000), by: `${actor.type}:${actor.id ?? "system"}` }];
      await tx.task.update({ where: { id: task.id }, data: { waiting: { ...waiting, inbox } as Prisma.InputJsonValue } });
      return task;
    });
    await audit(this.d.db, { workspaceId, actor, action: "task.signal", target: `task:${id}` });
    await this.publish(updated, "task.signal", {});
    await this.d.waits.wakeOnSignal({ workspaceId, id }, "external");
  }

  private async descendants(workspaceId: string, id: string): Promise<string[]> {
    const out: string[] = [];
    let frontier = [id];
    for (let depth = 0; depth < MAX_TASK_DEPTH && frontier.length; depth++) {
      const kids = await this.d.db.task.findMany({ where: { workspaceId, parentTaskId: { in: frontier } }, select: { id: true } });
      frontier = kids.map((k) => k.id);
      out.push(...frontier);
    }
    return out;
  }

  /** El contexto no puede apuntar a datos de otro workspace (p. ej. un leadId ajeno). */
  private async assertContext(workspaceId: string, context: Record<string, unknown>): Promise<void> {
    const refs: Array<[string, () => Promise<number>]> = [];
    if (typeof context.leadId === "string") refs.push(["leadId", () => this.d.db.lead.count({ where: { id: context.leadId as string, workspaceId } })]);
    if (typeof context.contactId === "string")
      refs.push(["contactId", () => this.d.db.contact.count({ where: { id: context.contactId as string, workspaceId } })]);
    for (const [key, count] of refs) {
      if (!/^[0-9a-f-]{36}$/i.test(String(context[key])) || (await count()) === 0) throw invalid("context_invalid", `${key} no existe en este workspace`);
    }
    if (JSON.stringify(context).length > 8_000) throw invalid("context_too_large", "El contexto no puede superar 8 KB");
  }

  private async tenantLimits(workspaceId: string): Promise<TaskLimitsInput> {
    const ws = await this.d.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    return TaskLimitsPatch.safeParse((ws.settings as { taskLimits?: unknown } | null)?.taskLimits ?? {}).data ?? {};
  }

  private publish(task: { id: string; workspaceId: string }, type: string, data: Prisma.InputJsonValue) {
    return this.d.bus.publish({ workspaceId: task.workspaceId, type, subject: `task:${task.id}`, data });
  }
}

/** Cierra el reloj del tramo en curso (suma al tiempo consumido). */
export function closeClock(task: { elapsedMs: number; segmentStartedAt: Date | null }, now = new Date()): { elapsedMs?: number; segmentStartedAt: null } {
  if (!task.segmentStartedAt) return { segmentStartedAt: null };
  return { elapsedMs: task.elapsedMs + Math.max(0, now.getTime() - task.segmentStartedAt.getTime()), segmentStartedAt: null };
}
