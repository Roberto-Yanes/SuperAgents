import { tool, type ToolSet } from "ai";
import type { Logger } from "pino";
import type { Db } from "../../data/db.js";
import type { EventBus } from "../../execution/events/bus.js";
import { toModelToolName, type ResolvedTool } from "../../integrations/tools/registry.js";
import type { TaskToolContext, ToolContext, ToolDef, ToolResult } from "../../integrations/tools/types.js";
import { canonicalJson, sha256Hex } from "../../shared/security/crypto.js";
import type { RunWithAgent, StepRecorder } from "./run-store.js";
import { faceOf } from "./prompt.js";

/** La llamada ya se había lanzado antes de una caída y no consta su resultado: no se repite. */
const UNKNOWN_TOOL_RESULT: ToolResult = {
  ok: false,
  error: "Esta acción ya se lanzó antes de una interrupción y no se sabe si terminó. No la repitas: avisa de que el equipo lo revisará.",
};

/** Tamaño máximo (bytes de JSON) de un resultado de tool que se devuelve al modelo (M8). */
export const MAX_TOOL_RESULT_BYTES = 8_192;

/**
 * Recorta resultados grandes antes de dárselos al modelo (coste, ventana de contexto y superficie de inyección).
 * El resultado completo queda en RunStep para auditoría.
 */
export function capToolResult(output: ToolResult, max = MAX_TOOL_RESULT_BYTES): ToolResult {
  const json = JSON.stringify(output);
  if (Buffer.byteLength(json, "utf8") <= max) return output;
  if (!output.ok) return { ok: false, error: output.error.slice(0, 1_000), ...(output.retryable ? { retryable: true } : {}) };
  const preview = Buffer.from(json, "utf8")
    .subarray(0, max - 300)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return { ok: true, truncated: true, note: `Resultado recortado (${json.length} caracteres). Pide datos más concretos si necesitas el resto.`, preview };
}

/**
 * Traduce las tools resueltas de un agente al formato del AI SDK y las ejecuta con su contexto.
 * Las que requieren aprobación se entregan SIN execute: el SDK detiene el bucle y deja la llamada pendiente.
 */
export class ToolBinder {
  /** Operaciones de tarea del tramo en curso, por run (las usan también las tools aprobadas al reanudar). */
  private readonly taskOps = new Map<string, TaskToolContext>();

  constructor(private readonly d: { db: Db; bus: EventBus; log: Logger }) {}

  setTaskContext(runId: string, ops: TaskToolContext | null): void {
    if (ops) this.taskOps.set(runId, ops);
    else this.taskOps.delete(runId);
  }

  /**
   * @param stepIndex pasos del modelo completados (= los del checkpoint). Junto con tool y argumentos forma la huella
   *   de una llamada con efectos: al recuperar un run desde el checkpoint, la misma llamada no se repite (H3).
   */
  bind(run: RunWithAgent, resolved: ResolvedTool[], steps: StepRecorder, stepIndex: () => number = () => run.stepCount): ToolSet {
    const set: ToolSet = {};
    for (const { def, mode } of resolved) {
      const name = toModelToolName(def.name);
      if (mode !== "NEVER") {
        set[name] = tool({ description: def.description, inputSchema: def.input });
        continue;
      }
      set[name] = tool({
        description: def.description,
        inputSchema: def.input,
        execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
          const dedupeKey = def.risk === "read" ? undefined : `${stepIndex()}:${def.name}:${sha256Hex(canonicalJson(input))}`;
          if (dedupeKey) {
            const prior = await steps.findByDedupeKey(dedupeKey);
            if (prior) {
              await steps.record("note", { toolName: def.name, toolCallId, data: { dedupeOf: prior.toolCallId, replayed: prior.hasResult } });
              return capToolResult(prior.hasResult ? (prior.output as ToolResult) : UNKNOWN_TOOL_RESULT);
            }
          }
          try {
            await steps.record("tool_call", { toolName: def.name, toolCallId, ...(dedupeKey ? { dedupeKey } : {}), data: { input } });
          } catch (err) {
            // Misma huella registrada a la vez por otra llamada idéntica del mismo paso: solo se ejecuta una.
            if ((err as { code?: string }).code === "P2002") return capToolResult(UNKNOWN_TOOL_RESULT);
            throw err;
          }
          await this.d.bus.publish({ workspaceId: run.workspaceId, type: "tool.called", subject: `run:${run.id}`, data: { tool: def.name, toolCallId } });
          const output = await this.execute(def, input, this.context(run, `${run.id}:${toolCallId}`));
          await steps.record("tool_result", { toolName: def.name, toolCallId, data: { output } }); // completo en RunStep
          return capToolResult(output);
        },
      });
    }
    return set;
  }

  /** Valida argumentos y ejecuta. Nunca lanza: los errores vuelven al modelo como { ok: false }. */
  async execute(def: ToolDef, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) return { ok: false, error: `Argumentos inválidos: ${parsed.error.message}` };
    try {
      return await def.execute(parsed.data, ctx);
    } catch (err) {
      ctx.log.error({ err, tool: def.name }, "tool error");
      return { ok: false, error: "La herramienta falló. Inténtalo de otra forma o deriva a una persona.", retryable: true };
    }
  }

  /** workspaceId, runId y contacto salen del sistema, nunca de los argumentos del modelo. */
  context(run: RunWithAgent, idempotencyKey: string): ToolContext {
    return {
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      runId: run.id,
      conversationId: run.conversationId,
      contactId: run.conversation?.contactId ?? null,
      face: faceOf(run),
      idempotencyKey,
      task: this.taskOps.get(run.id) ?? null,
      db: this.d.db,
      bus: this.d.bus,
      log: this.d.log.child({ runId: run.id }),
    };
  }
}
