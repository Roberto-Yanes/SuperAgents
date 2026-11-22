import type { ModelMessage } from "ai";
import { Prisma, type Db } from "../../data/db.js";
import type { Task } from "../../data/generated/prisma/client.js";
import type { TaskStatus } from "../../data/generated/prisma/enums.js";
import type { EventBus } from "../../execution/events/bus.js";
import { enqueueRun, type JobQueue } from "../../execution/queue/jobs.js";
import type { WaitPort, WaitSignal } from "../../execution/queue/ports.js";
import type { PlanStep, TaskToolContext } from "../../integrations/tools/types.js";
import { exhausted, limitsOf, resolveLimits, TaskLimitsPatch, type BlockReason, type TaskSourceKind } from "../../domain/tasks/limits.js";
import { closeClock, MAX_TASK_DEPTH, TERMINAL_TASK } from "../../domain/tasks/service.js";
import { invalid, notFound } from "../../shared/errors.js";
import { fromJson, toJson, type RunWithAgent } from "./run-store.js";

/** Lo que una tool de tarea pidió durante el tramo; el runtime lo aplica al cerrar el tramo. */
export interface SegmentControl {
  wait?: { until?: Date; reason: string };
  delegated?: Array<{ childTaskId: string; goal: string }>;
}

const CHANNEL_GOAL = "Atender la conversación con el contacto";

/**
 * Persistencia de la Task desde el runtime (ADR 003): crear la tarea de un tramo que no la tiene, abrir y cerrar
 * tramos, anotar el gasto, pausar, bloquear, terminar y despertar. Toda transición es condicionada: una tarea
 * cancelada o terminada no se resucita.
 */
export class TaskStore {
  constructor(private readonly d: { db: Db; bus: EventBus; queue: JobQueue; waits: WaitPort }) {}

  /** Tarea del tramo. Los runs de canal, rutina o secuencia sin tarea abren una tarea corta atada a ellos. */
  async ensureTask(run: RunWithAgent): Promise<Task> {
    if (run.taskId) {
      const task = await this.d.db.task.findFirst({ where: { id: run.taskId, workspaceId: run.workspaceId } });
      if (task) return task;
    }
    const routine = run.trigger === "routine" || run.trigger === "sequence";
    const source: TaskSourceKind = routine ? "ROUTINE" : run.conversationId ? "CHANNEL" : "APP";
    const input = (run.input ?? {}) as { instruction?: string; text?: string; routineId?: string };
    const goal = (routine ? input.instruction : source === "APP" ? input.text : undefined) ?? CHANNEL_GOAL;
    const ws = await this.d.db.workspace.findUniqueOrThrow({ where: { id: run.workspaceId }, select: { settings: true } });
    const tenant = TaskLimitsPatch.safeParse((ws.settings as { taskLimits?: unknown } | null)?.taskLimits ?? {}).data;
    return this.d.db.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          workspaceId: run.workspaceId,
          agentId: run.agentId,
          goal: goal.slice(0, 4_000),
          source,
          launchedBy: routine ? `routine:${input.routineId ?? run.trigger}` : source === "CHANNEL" ? "channel" : "system",
          conversationId: run.conversationId,
          contactId: run.conversation?.contactId ?? null,
          limits: resolveLimits(source, undefined, tenant) as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.run.updateMany({ where: { id: run.id, workspaceId: run.workspaceId }, data: { taskId: task.id } });
      return task;
    });
  }

  get(workspaceId: string, taskId: string): Promise<Task | null> {
    return this.d.db.task.findFirst({ where: { id: taskId, workspaceId } });
  }

  /** Abre un tramo: arranca el reloj y deja la tarea en PLANNING (sin plan) o RUNNING. */
  async startSegment(task: Task): Promise<Task | null> {
    if (TERMINAL_TASK.includes(task.status)) return null;
    const status: TaskStatus = task.planVersion > 0 || task.status !== "PLANNING" ? "RUNNING" : "PLANNING";
    const res = await this.d.db.task.updateMany({
      where: { id: task.id, workspaceId: task.workspaceId, status: { notIn: TERMINAL_TASK } },
      data: { status, blockedReason: null, waiting: Prisma.DbNull, ...(task.segmentStartedAt ? {} : { segmentStartedAt: new Date() }) },
    });
    if (res.count === 0) return null;
    if (status !== task.status) await this.publish(task, "task.status", { status });
    return this.get(task.workspaceId, task.id);
  }

  /**
   * Gasto de un paso del modelo: pasos (1 llamada + sus tools) y costo de referencia.
   * El costo sube también por los ancestros (la hija descuenta del cupo de la padre).
   */
  async accountStep(
    task: Task,
    run: { id: string; workspaceId: string },
    step: { steps: number; costUsd: number; usage: unknown; model?: string | null },
  ): Promise<void> {
    const cost = new Prisma.Decimal(step.costUsd);
    await this.d.db.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: { id: task.id, workspaceId: task.workspaceId },
        data: { spentSteps: { increment: step.steps }, spentCostUsd: { increment: cost } },
      });
      const current = await tx.run.findFirstOrThrow({ where: { id: run.id, workspaceId: run.workspaceId }, select: { usage: true } });
      await tx.run.updateMany({
        where: { id: run.id, workspaceId: run.workspaceId },
        data: { costUsd: { increment: cost }, usage: mergeUsageJson(current.usage, step.usage), ...(step.model ? { model: step.model } : {}) },
      });
      let parentId = task.parentTaskId;
      for (let i = 0; parentId && i < MAX_TASK_DEPTH; i++) {
        await tx.task.updateMany({ where: { id: parentId, workspaceId: task.workspaceId }, data: { spentCostUsd: { increment: cost } } });
        const parent = await tx.task.findFirst({ where: { id: parentId, workspaceId: task.workspaceId }, select: { parentTaskId: true } });
        parentId = parent?.parentTaskId ?? null;
      }
    });
  }

  /** Cupo agotado ahora mismo (lee el gasto persistido). */
  async exhausted(task: Task, extra: { steps?: number; costUsd?: number } = {}): Promise<BlockReason | null> {
    const fresh = await this.get(task.workspaceId, task.id);
    return fresh ? exhausted(fresh, extra) : null;
  }

  async updatePlan(task: Task, steps: PlanStep[], note?: string): Promise<number> {
    const ids = new Set<string>();
    for (const s of steps) {
      if (ids.has(s.id)) throw invalid("plan_invalid", `Paso repetido: ${s.id}`);
      ids.add(s.id);
    }
    const updated = await this.d.db.task.update({
      where: { id: task.id },
      data: { plan: steps as unknown as Prisma.InputJsonValue, planVersion: { increment: 1 }, ...(task.status === "PLANNING" ? { status: "RUNNING" } : {}) },
    });
    await this.publish(task, "task.plan", { version: updated.planVersion, plan: steps as unknown as Prisma.InputJsonValue, ...(note ? { note } : {}) });
    if (task.status === "PLANNING") await this.publish(task, "task.status", { status: "RUNNING" });
    return updated.planVersion;
  }

  /** Pausa (aprobación, dato externo, hija). Con pauseClockOnWait el reloj se detiene. */
  async pause(
    task: Task,
    status: "WAITING_APPROVAL" | "WAITING_EXTERNAL" | "WAITING_CHILD",
    extra: { checkpoint?: ModelMessage[]; waiting?: object } = {},
  ): Promise<boolean> {
    const now = new Date();
    const res = await this.d.db.task.updateMany({
      where: { id: task.id, workspaceId: task.workspaceId, status: { notIn: TERMINAL_TASK } },
      data: {
        status,
        ...(limitsOf(task.limits).pauseClockOnWait ? closeClock(task, now) : {}),
        ...(extra.checkpoint ? { checkpoint: toJson(extra.checkpoint) } : {}),
        ...(extra.waiting ? { waiting: extra.waiting as Prisma.InputJsonValue } : {}),
      },
    });
    if (res.count === 1) await this.publish(task, "task.status", { status, ...(extra.waiting ? { waiting: extra.waiting as Prisma.InputJsonValue } : {}) });
    return res.count === 1;
  }

  async block(task: Task, reason: BlockReason, checkpoint?: ModelMessage[]): Promise<void> {
    const now = new Date();
    const res = await this.d.db.task.updateMany({
      where: { id: task.id, workspaceId: task.workspaceId, status: { notIn: TERMINAL_TASK } },
      data: { status: "BLOCKED", blockedReason: reason, ...closeClock(task, now), ...(checkpoint ? { checkpoint: toJson(checkpoint) } : {}) },
    });
    if (res.count === 1) await this.publish(task, "task.blocked", { status: "BLOCKED", reason });
  }

  async finish(
    task: Task,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    extra: { result?: string; error?: string; checkpoint?: ModelMessage[] } = {},
  ): Promise<void> {
    const now = new Date();
    const res = await this.d.db.task.updateMany({
      where: { id: task.id, workspaceId: task.workspaceId, status: { notIn: TERMINAL_TASK } },
      data: {
        status,
        finishedAt: now,
        waiting: Prisma.DbNull,
        result: extra.result ?? null,
        error: extra.error ?? null,
        ...closeClock(task, now),
        ...(extra.checkpoint ? { checkpoint: toJson(extra.checkpoint) } : {}),
      },
    });
    if (res.count === 0) return;
    await this.publish(task, "task.finished", { status, ...(extra.error ? { error: extra.error } : {}) });
    if (task.parentTaskId) await this.d.waits.wakeOnSignal({ workspaceId: task.workspaceId, id: task.parentTaskId }, "child");
  }

  /** Crea la hija de una delegación con su primer tramo. Profundidad ≤ 3; su costo no supera lo que le queda a la padre. */
  async createChild(
    parent: Task,
    input: { goal: string; agentId?: string; maxSteps?: number; maxCostUsd?: number },
  ): Promise<{ childTaskId: string; agentId: string }> {
    if (parent.depth + 1 > MAX_TASK_DEPTH) throw invalid("delegation_too_deep", `No se puede delegar más allá de ${MAX_TASK_DEPTH} niveles`);
    const agent = await this.d.db.agent.findFirst({ where: { id: input.agentId ?? parent.agentId, workspaceId: parent.workspaceId, status: "ACTIVE" } });
    if (!agent) throw notFound("Agente");
    const fresh = (await this.get(parent.workspaceId, parent.id)) ?? parent;
    const parentLimits = limitsOf(fresh.limits);
    const remainingCost = Math.max(0, parentLimits.maxCostUsd - Number(fresh.spentCostUsd.toString()));
    if (remainingCost <= 0) throw invalid("delegation_no_budget", "La tarea no tiene cupo de costo para delegar");
    const base = resolveLimits("DELEGATION", { ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}) }, undefined);
    const limits = { ...base, maxCostUsd: Math.min(input.maxCostUsd ?? base.maxCostUsd, remainingCost), pauseClockOnWait: parentLimits.pauseClockOnWait };
    const { task, run } = await this.d.db.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          workspaceId: parent.workspaceId,
          agentId: agent.id,
          goal: input.goal,
          source: "DELEGATION",
          launchedBy: `task:${parent.id}`,
          parentTaskId: parent.id,
          depth: parent.depth + 1,
          limits: limits as unknown as Prisma.InputJsonValue,
        },
      });
      const run = await tx.run.create({
        data: { workspaceId: parent.workspaceId, agentId: agent.id, agentVersion: agent.version, taskId: task.id, trigger: "task", input: { taskId: task.id } },
      });
      return { task, run };
    });
    await this.publish(task, "task.created", { status: task.status, goal: task.goal, source: task.source, parentTaskId: parent.id, runId: run.id });
    await this.publish(parent, "task.delegated", { childTaskId: task.id, agentId: agent.id });
    await enqueueRun(this.d.queue, run, "execute");
    return { childTaskId: task.id, agentId: agent.id };
  }

  /**
   * Despierta una tarea en espera con un tramo nuevo. Solo si la espera que la señal resuelve sigue vigente
   * (una señal repetida o un plazo viejo no abren otro tramo). Devuelve el run creado o null.
   */
  async wake(workspaceId: string, taskId: string, signal: WaitSignal | "timer", token?: string): Promise<{ runId: string } | null> {
    const created = await this.d.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`task:${taskId}`}, 0))`;
      const task = await tx.task.findFirst({ where: { id: taskId, workspaceId }, include: { agent: true } });
      if (!task || TERMINAL_TASK.includes(task.status)) return null;
      const waiting = (task.waiting ?? {}) as {
        kind?: string;
        until?: string;
        reason?: string;
        token?: string;
        since?: string;
        inbox?: Array<{ text: string }>;
      };
      let note: string | null = null;
      if (signal === "timer" && task.status === "WAITING_EXTERNAL" && waiting.token && waiting.token === token) {
        note = `Se cumplió el plazo de la espera${waiting.reason ? ` («${waiting.reason}»)` : ""}. Continúa la tarea desde donde quedaste.`;
      } else if (signal === "external" && task.status === "WAITING_EXTERNAL" && waiting.inbox?.length) {
        note = `El dueño envió el dato que esperabas:\n${waiting.inbox.map((m) => `- ${m.text}`).join("\n")}\nContinúa la tarea.`;
      } else if (signal === "child" && task.status === "WAITING_CHILD") {
        const open = await tx.task.count({ where: { workspaceId, parentTaskId: task.id, status: { notIn: TERMINAL_TASK } } });
        if (open > 0) return null;
        const since = waiting.since ? new Date(waiting.since) : task.updatedAt;
        const done = await tx.task.findMany({ where: { workspaceId, parentTaskId: task.id, finishedAt: { gte: since } }, orderBy: { createdAt: "asc" } });
        note = [
          "Terminaron las tareas delegadas:",
          ...done.map((c) => `- [${c.status}] «${c.goal.slice(0, 200)}» → ${(c.result ?? c.error ?? "sin resultado").slice(0, 1_500)}`),
          "Continúa la tarea con esos resultados.",
        ].join("\n");
      } else if (signal === "limits" && task.status === "BLOCKED" && task.blockedReason !== "model_region" && !exhausted(task)) {
        note = "El dueño amplió el cupo de la tarea. Continúa desde donde quedaste.";
      }
      if (!note) return null;
      const checkpoint = [...fromJson(task.checkpoint), { role: "user", content: `[Plataforma] ${note}` } as ModelMessage];
      const moved = await tx.task.updateMany({
        where: { id: task.id, workspaceId, status: task.status },
        data: { status: "RUNNING", waiting: Prisma.DbNull, blockedReason: null, checkpoint: toJson(checkpoint) },
      });
      if (moved.count !== 1) return null;
      return tx.run.create({
        data: {
          workspaceId,
          agentId: task.agentId,
          agentVersion: task.agent.version,
          taskId: task.id,
          conversationId: task.conversationId,
          trigger: "task.wake",
          input: { taskId: task.id, signal },
          checkpoint: toJson(checkpoint),
        },
      });
    });
    if (!created) return null;
    await this.publish({ id: taskId, workspaceId }, "task.status", { status: "RUNNING", wokenBy: signal, runId: created.id });
    await enqueueRun(this.d.queue, created, "execute");
    return { runId: created.id };
  }

  /** Operaciones que ven las tools de tarea durante un tramo (implementa TaskToolContext). */
  toolContext(task: Task, control: SegmentControl): TaskToolContext {
    return {
      id: task.id,
      depth: task.depth,
      updatePlan: async (steps, note) => {
        const fresh = (await this.get(task.workspaceId, task.id)) ?? task;
        return { version: await this.updatePlan(fresh, steps, note) };
      },
      requestWait: async (wait) => {
        control.wait = wait;
      },
      delegate: async (input) => {
        const child = await this.createChild(task, input);
        (control.delegated ??= []).push({ childTaskId: child.childTaskId, goal: input.goal });
        return child;
      },
    };
  }

  publish(task: { id: string; workspaceId: string }, type: string, data: Prisma.InputJsonValue = {}) {
    return this.d.bus.publish({ workspaceId: task.workspaceId, type, subject: `task:${task.id}`, data });
  }
}

/** Suma de uso de tokens (acepta números o { total } del AI SDK). */
function mergeUsageJson(prev: unknown, next: unknown): Prisma.InputJsonValue {
  const n = (u: unknown, k: string): number => {
    const v = (u as Record<string, unknown> | null)?.[k];
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && typeof (v as { total?: unknown }).total === "number") return (v as { total: number }).total;
    return 0;
  };
  const keys = ["inputTokens", "outputTokens", "totalTokens"] as const;
  return Object.fromEntries(
    keys.map((k) => [k, n(prev, k) + (k === "totalTokens" && !n(next, k) ? n(next, "inputTokens") + n(next, "outputTokens") : n(next, k))]),
  );
}
