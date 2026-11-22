import { z } from "zod";
import { defineTool, type ToolDef } from "../types.js";

/**
 * Tools del loop autónomo (ADR 003). El runtime las añade solas a las tareas de cara interna
 * (app, rutina, delegación); nunca a una conversación con un contacto.
 * No tocan la base de datos: piden al runtime (ctx.task) que mueva el estado de la tarea.
 */
const outsideTask = { ok: false as const, error: "Esta herramienta solo existe dentro de una tarea." };

export const planUpdate = defineTool({
  name: "plan.update",
  description:
    "Escribe o revisa el plan de la tarea: la lista completa de pasos con su estado. Úsala al empezar (si el objetivo tiene más de un paso) y cada vez que avances, cambies de idea o descubras algo que cambie el plan.",
  input: z.object({
    steps: z
      .array(
        z.object({
          id: z.string().min(1).max(40).describe("Identificador corto y estable del paso, p. ej. 'p1'"),
          title: z.string().min(1).max(200),
          status: z.enum(["pending", "doing", "done", "skipped"]),
          note: z.string().max(500).optional(),
        }),
      )
      .min(1)
      .max(30),
    note: z.string().max(500).optional().describe("Por qué cambia el plan, en una frase"),
  }),
  scope: "tasks:write",
  risk: "read", // solo estado interno de la tarea, sin efectos fuera
  exposure: "internal",
  approval: "NEVER",
  async execute(input, ctx) {
    if (!ctx.task) return outsideTask;
    const { version } = await ctx.task.updatePlan(input.steps, input.note);
    return { ok: true, planVersion: version };
  },
});

export const taskWait = defineTool({
  name: "task.wait",
  description:
    "Pausa la tarea hasta una fecha o hasta que el dueño envíe un dato que falta. Úsala cuando no puedas seguir sin esperar (una respuesta, un documento, un plazo). La tarea se retoma sola desde aquí.",
  input: z.object({
    reason: z.string().min(3).max(300).describe("Qué esperas, en una frase que verá el dueño"),
    until: z.string().datetime({ offset: true }).optional().describe("Fecha ISO 8601 hasta la que esperar; sin fecha, espera un dato del dueño"),
  }),
  scope: "tasks:write",
  risk: "read",
  exposure: "internal",
  approval: "NEVER",
  async execute(input, ctx) {
    if (!ctx.task) return outsideTask;
    const until = input.until ? new Date(input.until) : undefined;
    if (until && until.getTime() <= Date.now()) return { ok: false, error: "La fecha de espera ya pasó" };
    await ctx.task.requestWait({ reason: input.reason, ...(until ? { until } : {}) });
    return { ok: true, waiting: true, until: until?.toISOString() ?? null, note: "La tarea queda en pausa tras este paso." };
  },
});

export const taskDelegate = defineTool({
  name: "task.delegate",
  description:
    "Delega una parte del objetivo en una tarea hija (otro agente o tú mismo con un objetivo acotado). Úsala solo si esa parte no la puedes cerrar en esta tarea. La tarea queda en pausa hasta que la hija termine y recibirás su resultado.",
  input: z.object({
    goal: z.string().min(5).max(2_000).describe("Objetivo concreto y autocontenido para la hija"),
    agentId: z.string().uuid().optional().describe("Agente del workspace que la hará; por defecto, el mismo"),
    maxSteps: z.number().int().min(1).max(60).optional(),
    maxCostUsd: z.number().positive().max(5).optional(),
  }),
  scope: "tasks:write",
  risk: "write",
  exposure: "internal",
  approval: "NEVER",
  async execute(input, ctx) {
    if (!ctx.task) return outsideTask;
    const child = await ctx.task.delegate(input);
    return { ok: true, childTaskId: child.childTaskId, agentId: child.agentId, note: "La tarea queda en pausa hasta que la hija termine." };
  },
});

export const taskTools: ToolDef[] = [planUpdate, taskWait, taskDelegate] as ToolDef[];
export const TASK_TOOL_NAMES = taskTools.map((t) => t.name);
