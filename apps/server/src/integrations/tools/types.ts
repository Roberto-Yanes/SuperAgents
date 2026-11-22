import type { z } from "zod";
import type { Logger } from "pino";
import type { Db } from "../../data/db.js";
import type { EventBus } from "../../execution/events/bus.js";
import type { ApprovalMode } from "../../data/generated/prisma/enums.js";

/** Riesgo declarado por la tool. La política del tenant decide si va directo o con aprobación (domain/workspaces/risk-policy.ts). */
export type { ToolRisk } from "../../domain/workspaces/risk-policy.js";
import type { ToolRisk } from "../../domain/workspaces/risk-policy.js";

/**
 * Cara en la que se ofrece una tool (H2):
 * - internal: chats del equipo del negocio (API/UI). Por defecto.
 * - external: además, conversaciones con contactos por canales (WhatsApp, email…), expuestas a prompt injection.
 */
export type ToolExposure = "internal" | "external";

/** Contexto que recibe una tool. workspaceId/runId salen del sistema, nunca de los argumentos del modelo. */
export interface ToolContext {
  workspaceId: string;
  agentId: string;
  runId: string;
  conversationId: string | null;
  contactId: string | null;
  /** Cara de la conversación: "external" = contacto por un canal; "internal" = equipo (API/UI). */
  face: ToolExposure;
  /** Clave estable por llamada: úsala para que una escritura externa no se repita. */
  idempotencyKey: string;
  /** Tarea en curso (ADR 003). null fuera de una tarea. Lo implementa el runtime; las tools no tocan su estado. */
  task: TaskToolContext | null;
  db: Db;
  bus: EventBus;
  log: Logger;
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "doing" | "done" | "skipped";
  note?: string;
}

/** Operaciones sobre la tarea en curso que el runtime ofrece a las tools de tarea. */
export interface TaskToolContext {
  id: string;
  depth: number;
  /** Reescribe el plan (versión nueva). */
  updatePlan(steps: PlanStep[], note?: string): Promise<{ version: number }>;
  /** Pide pausar la tarea tras este paso hasta una fecha o hasta que llegue un dato (WAITING_EXTERNAL). */
  requestWait(wait: { until?: Date; reason: string }): Promise<void>;
  /** Crea una tarea hija y pide pausar la tarea tras este paso (WAITING_CHILD). */
  delegate(input: { goal: string; agentId?: string; maxSteps?: number; maxCostUsd?: number }): Promise<{ childTaskId: string; agentId: string }>;
}

export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string; retryable?: boolean };

/**
 * Definición de tool (ToolDef). Una sola fuente de verdad para:
 * - el esquema que ve el modelo (input),
 * - el permiso que exige (scope),
 * - el riesgo y el modo de aprobación,
 * - la conexión que necesita (si aplica).
 */
export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  /** Permiso lógico, p. ej. "memory:write", "crm:write", "channel:send". */
  scope: string;
  risk: ToolRisk;
  /**
   * NEVER: se ejecuta sin preguntar.
   * ASK_OWNER: pide aprobación; el agente puede bajarlo a NEVER cuando el dueño confíe (toolConfig.approvals).
   * ALWAYS: pide aprobación siempre; ningún override lo baja.
   */
  approval: ApprovalMode;
  /** Por defecto "internal": una tool nueva no queda al alcance de desconocidos sin decidirlo. */
  exposure?: ToolExposure;
  /** Tipo de Connection requerida (p. ej. "composio", "channel.email"). */
  requiresConnection?: string;
  /** Texto legible que verá el dueño al aprobar. */
  preview?: (input: z.infer<I>) => string;
  execute: (input: z.infer<I>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<I extends z.ZodType>(def: ToolDef<I>): ToolDef<I> {
  return def;
}
