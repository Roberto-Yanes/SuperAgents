import type { ModelMessage } from "ai";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import type { EventBus } from "../../execution/events/bus.js";
import { fromModelToolName, toModelToolName, type ResolvedTool, type ToolCatalog } from "../../integrations/tools/registry.js";
import type { ToolResult } from "../../integrations/tools/types.js";
import { canonicalJson, sha256Hex } from "../../shared/security/crypto.js";
import { mergeUsage, toJson, type RunWithAgent, type StepRecorder } from "../runtime/run-store.js";
import { capToolResult, type ToolBinder } from "../runtime/tool-binder.js";

/** Resultado para el modelo cuando no se sabe si una acción se ejecutó (caída a mitad). */
export const UNKNOWN_RESULT: ToolResult = {
  ok: false,
  error: "La acción se interrumpió y no se sabe si llegó a completarse. No la repitas: avisa de que el equipo lo revisará.",
};

export interface PendingCall {
  toolCallId: string;
  toolName: string; // nombre del modelo (memory__save)
  input: unknown;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "json"; value: Prisma.JsonObject };
}

/**
 * Puerta de aprobaciones del runtime:
 * - request(): convierte llamadas pendientes en Approval y pausa el run (WAITING_APPROVAL).
 * - collect(): al reanudar, ejecuta lo aprobado UNA vez y devuelve los tool-result para el historial.
 */
export class ApprovalGate {
  constructor(private readonly d: { db: Db; bus: EventBus; tools: ToolCatalog; binder: ToolBinder; ttlHours: number }) {}

  async request(run: RunWithAgent, checkpoint: ModelMessage[], calls: PendingCall[], resolved: ResolvedTool[], usage: unknown): Promise<void> {
    const expiresAt = new Date(Date.now() + this.d.ttlHours * 3_600_000);
    const byName = new Map(resolved.map((r) => [r.def.name, r]));
    const created = await this.d.db.$transaction(async (tx) => {
      const out = [];
      for (const call of calls) {
        const toolName = fromModelToolName(call.toolName);
        const r = byName.get(toolName);
        const preview = r?.def.preview ? r.def.preview(call.input as never) : `${toolName} ${canonicalJson(call.input)}`;
        out.push(
          await tx.approval.upsert({
            where: { runId_toolCallId: { runId: run.id, toolCallId: call.toolCallId } },
            update: {},
            create: {
              workspaceId: run.workspaceId,
              runId: run.id,
              toolName,
              toolCallId: call.toolCallId,
              args: call.input as Prisma.InputJsonValue,
              preview,
              mode: r?.mode ?? "ALWAYS",
              idempotencyKey: sha256Hex(`${run.id}:${call.toolCallId}:${canonicalJson(call.input)}`),
              expiresAt,
            },
          }),
        );
      }
      // Condicionado a RUNNING: si se canceló mientras el modelo pensaba, no se resucita el run.
      await tx.run.updateMany({
        where: { id: run.id, status: "RUNNING" },
        data: { status: "WAITING_APPROVAL", checkpoint: toJson(checkpoint), usage: mergeUsage(run.usage, usage) },
      });
      return out;
    });
    for (const a of created) {
      await this.d.bus.publish({
        workspaceId: run.workspaceId,
        type: "approval.requested",
        subject: `run:${run.id}`,
        data: { approvalId: a.id, tool: a.toolName, preview: a.preview, expiresAt: a.expiresAt.toISOString() },
      });
    }
  }

  async collect(run: RunWithAgent, messages: ModelMessage[], steps: StepRecorder): Promise<ToolResultPart[]> {
    const answered = answeredToolCallIds(messages);
    const decided = await this.d.db.approval.findMany({
      where: { workspaceId: run.workspaceId, runId: run.id, status: { in: ["APPROVED", "EXECUTING", "REJECTED", "EXPIRED", "EXECUTED", "FAILED", "UNKNOWN"] } },
      orderBy: { createdAt: "asc" },
    });
    const parts: ToolResultPart[] = [];
    for (const approval of decided) {
      if (answered.has(approval.toolCallId)) continue;
      let output: ToolResult;
      switch (approval.status) {
        case "APPROVED":
          output = await this.executeApproved(run, approval);
          break;
        case "EXECUTED":
        case "FAILED": // ya ejecutada antes de una caída: se reutiliza el resultado, no se repite
          output = (approval.result as ToolResult | null) ?? { ok: false, error: "Sin resultado registrado" };
          break;
        case "EXECUTING": // el proceso murió durante la ejecución: no se sabe si ocurrió (H3)
          output = await this.markUnknown(run, approval);
          break;
        case "UNKNOWN":
          output = UNKNOWN_RESULT;
          break;
        case "REJECTED":
          output = { ok: false, error: "El dueño rechazó esta acción. No la repitas.", ...(approval.reason ? { reason: approval.reason } : {}) };
          break;
        default:
          output = { ok: false, error: "La aprobación caducó sin respuesta. No la repitas." };
      }
      parts.push({
        type: "tool-result",
        toolCallId: approval.toolCallId,
        toolName: toModelToolName(approval.toolName),
        output: { type: "json", value: capToolResult(output) as unknown as Prisma.JsonObject },
      });
      await steps.record("tool_result", { toolName: approval.toolName, toolCallId: approval.toolCallId, data: { output } });
    }
    return parts;
  }

  private async markUnknown(run: RunWithAgent, approval: { id: string; toolName: string; toolCallId: string }): Promise<ToolResult> {
    const res = await this.d.db.approval.updateMany({
      where: { id: approval.id, status: "EXECUTING" },
      data: { status: "UNKNOWN", result: UNKNOWN_RESULT as unknown as Prisma.InputJsonValue },
    });
    if (res.count === 1) {
      await this.d.bus.publish({
        workspaceId: run.workspaceId,
        type: "approval.unknown",
        subject: `run:${run.id}`,
        data: { approvalId: approval.id, tool: approval.toolName, toolCallId: approval.toolCallId },
      });
    }
    return UNKNOWN_RESULT;
  }

  private async executeApproved(
    run: RunWithAgent,
    approval: { id: string; toolName: string; toolCallId: string; args: unknown; idempotencyKey: string },
  ): Promise<ToolResult> {
    // H3: toma condicionada ANTES de ejecutar. Si el proceso cae después, la aprobación queda en EXECUTING
    // y la recuperación la marca UNKNOWN en lugar de repetir la acción.
    const claimed = await this.d.db.approval.updateMany({ where: { id: approval.id, status: "APPROVED" }, data: { status: "EXECUTING" } });
    if (claimed.count !== 1) {
      const now = await this.d.db.approval.findUniqueOrThrow({ where: { id: approval.id } });
      if (now.status === "EXECUTED" || now.status === "FAILED") return (now.result as ToolResult | null) ?? { ok: false, error: "Sin resultado registrado" };
      return now.status === "EXECUTING" ? this.markUnknown(run, approval) : UNKNOWN_RESULT;
    }
    const def = await this.d.tools.resolve(run.workspaceId, approval.toolName);
    const output: ToolResult = def
      ? await this.d.binder.execute(def, approval.args, this.d.binder.context(run, approval.idempotencyKey))
      : { ok: false, error: `La tool ${approval.toolName} ya no está disponible` };
    await this.d.db.approval.updateMany({
      where: { id: approval.id, status: "EXECUTING" },
      data: { status: output.ok ? "EXECUTED" : "FAILED", result: output as unknown as Prisma.InputJsonValue },
    });
    await this.d.bus.publish({
      workspaceId: run.workspaceId,
      type: "tool.called",
      subject: `run:${run.id}`,
      data: { tool: approval.toolName, toolCallId: approval.toolCallId, approvalId: approval.id, ok: output.ok },
    });
    return output;
  }
}

/** Añade los tool-result al historial: en el último mensaje "tool" si existe, si no en uno nuevo. */
export function appendToolResults(messages: ModelMessage[], parts: ToolResultPart[]): ModelMessage[] {
  if (parts.length === 0) return messages;
  const out = [...messages];
  const last = out.at(-1);
  if (last?.role === "tool") out[out.length - 1] = { ...last, content: [...last.content, ...parts] };
  else out.push({ role: "tool", content: parts });
  return out;
}

function answeredToolCallIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const part of m.content) if (part.type === "tool-result") ids.add(part.toolCallId);
  }
  return ids;
}
