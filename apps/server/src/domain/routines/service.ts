import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Db } from "../../data/db.js";
import { enqueueRun, type JobQueue } from "../../execution/queue/jobs.js";
import { audit, type Actor } from "../../data/audit.js";
import { invalid, notFound } from "../../shared/errors.js";

/** Puerto: quién programa las ejecuciones periódicas (lo implementa execution/queue con pg-boss schedule). */
export interface RoutineScheduler {
  schedule(routine: { id: string; workspaceId: string; cron: string; timezone: string }): Promise<void>;
  unschedule(routineId: string): Promise<void>;
}

export const RoutineInput = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(120),
  cron: z.string().min(9).max(120),
  timezone: z.string().optional(),
  instruction: z.string().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  enabled: z.boolean().default(true),
});
export type RoutineInput = z.infer<typeof RoutineInput>;

const MIN_INTERVAL_MS = 15 * 60_000;

/** Rutinas: el agente ejecuta una instrucción según un cron en la zona horaria del workspace (o la indicada). */
export class RoutineService {
  constructor(private readonly d: { db: Db; system: Db; queue: JobQueue; scheduler: RoutineScheduler }) {}

  list(workspaceId: string) {
    return this.d.db.routine.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  }

  async get(workspaceId: string, id: string) {
    const r = await this.d.db.routine.findFirst({ where: { id, workspaceId } });
    if (!r) throw notFound("Rutina");
    return r;
  }

  async create(workspaceId: string, input: RoutineInput, actor: Actor) {
    const ws = await this.d.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const timezone = input.timezone ?? ws.timezone;
    validateCron(input.cron, timezone);
    await this.assertRefs(workspaceId, input.agentId, input.conversationId);
    const routine = await this.d.db.routine.create({
      data: {
        workspaceId,
        agentId: input.agentId,
        name: input.name,
        cron: input.cron,
        timezone,
        instruction: input.instruction,
        conversationId: input.conversationId ?? null,
        enabled: input.enabled,
      },
    });
    if (routine.enabled) await this.d.scheduler.schedule(routine);
    await audit(this.d.db, { workspaceId, actor, action: "routine.created", target: `routine:${routine.id}` });
    return routine;
  }

  async update(workspaceId: string, id: string, input: Partial<RoutineInput>, actor: Actor) {
    const current = await this.get(workspaceId, id);
    const cron = input.cron ?? current.cron;
    const timezone = input.timezone ?? current.timezone;
    validateCron(cron, timezone);
    await this.assertRefs(workspaceId, input.agentId ?? current.agentId, input.conversationId ?? current.conversationId ?? undefined);
    const routine = await this.d.db.routine.update({ where: { id }, data: { ...input, cron, timezone } });
    if (routine.enabled) await this.d.scheduler.schedule(routine);
    else await this.d.scheduler.unschedule(id);
    await audit(this.d.db, { workspaceId, actor, action: "routine.updated", target: `routine:${id}` });
    return routine;
  }

  async remove(workspaceId: string, id: string, actor: Actor): Promise<void> {
    await this.get(workspaceId, id);
    await this.d.scheduler.unschedule(id);
    await this.d.db.routine.delete({ where: { id } });
    await audit(this.d.db, { workspaceId, actor, action: "routine.deleted", target: `routine:${id}` });
  }

  /** Disparo (job routine.cron o «ejecutar ahora»): crea el run y lo encola. */
  async fire(workspaceId: string, routineId: string): Promise<{ runId: string } | null> {
    const r = await this.d.db.routine.findFirst({ where: { id: routineId, workspaceId }, include: { agent: true } });
    if (!r || !r.enabled || r.agent.status !== "ACTIVE") return null;
    const run = await this.d.db.run.create({
      data: {
        workspaceId,
        agentId: r.agentId,
        agentVersion: r.agent.version,
        conversationId: r.conversationId,
        trigger: "routine",
        input: { instruction: r.instruction, routineId: r.id },
      },
    });
    await this.d.db.routine.update({ where: { id: r.id }, data: { lastRunAt: new Date() } });
    await enqueueRun(this.d.queue, run, "execute");
    return { runId: run.id };
  }

  /** Reprograma todas las rutinas activas (al arrancar el worker). Cruza workspaces: usa el cliente de sistema. */
  async scheduleAll(): Promise<number> {
    const routines = await this.d.system.routine.findMany({ where: { enabled: true } });
    for (const r of routines) await this.d.scheduler.schedule(r);
    return routines.length;
  }

  /**
   * Dispara las rutinas cuya ocurrencia anterior aún no se ejecutó. Un pase, no se pone al día
   * de varias ocurrencias perdidas. Lo llama el job routine.cron cada minuto.
   */
  async tick(now = new Date()): Promise<number> {
    const routines = await this.d.system.routine.findMany({ where: { enabled: true }, include: { agent: true } });
    let fired = 0;
    for (const r of routines) {
      if (r.agent.status !== "ACTIVE") continue;
      let prev: Date;
      try {
        prev = CronExpressionParser.parse(r.cron, { tz: r.timezone, currentDate: now }).prev().toDate();
      } catch {
        continue;
      }
      if (r.lastRunAt && r.lastRunAt >= prev) continue;
      if (await this.fire(r.workspaceId, r.id)) fired += 1;
    }
    return fired;
  }

  private async assertRefs(workspaceId: string, agentId: string, conversationId?: string): Promise<void> {
    if (!(await this.d.db.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } }))) throw notFound("Agente");
    if (conversationId && !(await this.d.db.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { id: true } })))
      throw notFound("Conversación");
  }
}

/** Cron válido, zona horaria válida y no más frecuente que cada 15 minutos. */
export function validateCron(cron: string, timezone: string): void {
  let it;
  try {
    it = CronExpressionParser.parse(cron, { tz: timezone });
  } catch {
    throw invalid("invalid_cron", `Expresión cron o zona horaria inválida: "${cron}" (${timezone})`);
  }
  const a = it.next().getTime();
  const b = it.next().getTime();
  if (b - a < MIN_INTERVAL_MS) throw invalid("cron_too_frequent", "Una rutina no puede ejecutarse más de una vez cada 15 minutos");
}
