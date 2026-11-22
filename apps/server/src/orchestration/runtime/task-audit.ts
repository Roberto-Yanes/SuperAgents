import type { Db } from "../../data/db.js";
import type { Task } from "../../data/generated/prisma/client.js";
import { audit, systemActor } from "../../data/audit.js";
import type { ToolCatalog } from "../../integrations/tools/registry.js";
import type { RunWithAgent } from "./run-store.js";

export type SegmentOutcome = "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED" | "WAITING_APPROVAL" | "WAITING_EXTERNAL" | "WAITING_CHILD";

/** Categorías de datos personales o de negocio que toca una tool, por su nombre (ADR 003, auditoría). */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/^(contact|memory)\./, "contacto"],
  [/^lead\./, "lead"],
  [/^(agenda|appointment)\./, "agenda"],
  [/^(kb|knowledge)\./, "documento"],
  [/^handoff\./, "mensaje"],
  [/^composio\.(gmail|outlook|mail)/, "correo"],
  [/^composio\./, "app_externa"],
];

export function dataCategoriesFor(toolNames: string[], hasConversation: boolean): string[] {
  const out = new Set<string>(hasConversation ? ["mensaje"] : []);
  for (const name of toolNames) for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) out.add(cat);
  return [...out].sort();
}

/** Una frase: lo que el agente iba a hacer o hizo. Nunca la cadena de pensamiento ni el texto completo. */
export function oneSentence(text: string | undefined, max = 200): string | null {
  if (!text) return null;
  const first =
    text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * Registro de auditoría de cada tramo (ADR 003 / ADR 005, E8): lo que un cliente europeo puede mostrar.
 * Objetivo y quién lo lanzó, decisión en una frase, categorías de datos, tools (nombre, riesgo, aprobación y
 * resultado), modelo, proveedor, región, resultado y costo. Sin secretos ni payloads de tools: el detalle
 * completo sigue en RunStep, con su retención.
 */
export class TaskAudit {
  constructor(private readonly d: { db: Db; tools: ToolCatalog }) {}

  async segment(
    run: RunWithAgent,
    task: Task,
    e: {
      outcome: SegmentOutcome;
      model: { provider: string; region: string; modelId: string } | null;
      decision?: string;
      error?: string;
      blockedReason?: string;
    },
  ): Promise<void> {
    const [calls, results, approvals, fresh] = await Promise.all([
      this.d.db.runStep.findMany({ where: { workspaceId: run.workspaceId, runId: run.id, kind: "tool_call" }, select: { toolName: true, toolCallId: true } }),
      this.d.db.runStep.findMany({ where: { workspaceId: run.workspaceId, runId: run.id, kind: "tool_result" }, select: { toolCallId: true, data: true } }),
      this.d.db.approval.findMany({ where: { workspaceId: run.workspaceId, runId: run.id }, select: { toolName: true, toolCallId: true, status: true } }),
      this.d.db.run.findFirst({ where: { id: run.id, workspaceId: run.workspaceId }, select: { costUsd: true } }),
    ]);
    const okByCall = new Map(results.map((r) => [r.toolCallId, (r.data as { output?: { ok?: boolean } }).output?.ok === true]));
    const entries = [
      ...calls.map((c) => ({
        name: c.toolName ?? "?",
        toolCallId: c.toolCallId,
        approval: "none" as string,
        result: okByCall.get(c.toolCallId) ? "ok" : "error",
      })),
      ...approvals
        .filter((a) => !calls.some((c) => c.toolCallId === a.toolCallId))
        .map((a) => ({
          name: a.toolName,
          toolCallId: a.toolCallId,
          approval: a.status.toLowerCase(),
          result: a.status === "EXECUTED" ? "ok" : a.status.toLowerCase(),
        })),
    ];
    const tools = [];
    for (const t of entries) {
      const def = await this.d.tools.resolve(run.workspaceId, t.name).catch(() => undefined);
      tools.push({ name: t.name, risk: def?.risk ?? "unknown", approval: t.approval, result: t.result });
    }
    await audit(this.d.db, {
      workspaceId: run.workspaceId,
      actor: systemActor,
      action: "task.segment",
      target: `task:${task.id}`,
      data: {
        taskId: task.id,
        runId: run.id,
        source: task.source,
        launchedBy: task.launchedBy,
        goal: task.goal.slice(0, 500),
        outcome: e.outcome,
        ...(e.blockedReason ? { blockedReason: e.blockedReason } : {}),
        decision: oneSentence(e.decision ?? e.error),
        dataCategories: dataCategoriesFor(
          tools.map((t) => t.name),
          Boolean(run.conversationId),
        ),
        tools,
        model: e.model ? { id: e.model.modelId, provider: e.model.provider, region: e.model.region } : null,
        costUsd: Number(fresh?.costUsd.toString() ?? 0),
      },
    });
  }
}
