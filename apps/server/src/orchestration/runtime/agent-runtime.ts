import { stepCountIs, streamText, type ModelMessage } from "ai";
import type { Logger } from "pino";
import type { Db } from "../../data/db.js";
import type { EventBus } from "../../execution/events/bus.js";
import type { LlmResolver } from "../llm/registry.js";
import { toModelToolName, type AgentToolConfig, type ToolCatalog } from "../../integrations/tools/registry.js";
import type { ApprovalGate } from "../approvals/approval-gate.js";
import { appendToolResults } from "../approvals/approval-gate.js";
import type { ReplyDelivery } from "./reply-delivery.js";
import type { ToolBinder } from "./tool-binder.js";
import { fromJson, StepRecorder, type RunStore, type RunWithAgent } from "./run-store.js";
import { buildSystemPrompt, faceOf, historyToMessages } from "./prompt.js";
import type { ConversationService } from "../../domain/conversations/service.js";

export interface RuntimeDeps {
  db: Db;
  bus: EventBus;
  llm: LlmResolver;
  tools: ToolCatalog;
  runs: RunStore;
  binder: ToolBinder;
  gate: ApprovalGate;
  delivery: ReplyDelivery;
  conversations: Pick<ConversationService, "releaseQueued">;
  log: Logger;
  maxSteps: number;
}

/** Runs que existen para contestar mensajes. Rutinas y secuencias llevan su propia instrucción. */
const NOT_INBOUND = new Set(["routine", "sequence"]);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** Flush de deltas de texto al bus: cada DELTA_FLUSH_MS o DELTA_FLUSH_CHARS, lo que llegue antes. */
const DELTA_FLUSH_MS = 120;
const HEARTBEAT_MS = 60_000;
const DELTA_FLUSH_CHARS = 200;
const HISTORY_LIMIT = 30;

/**
 * Agent runtime: SOLO orquesta el bucle de tool calling.
 * Persistencia → RunStore · tools → ToolBinder · aprobaciones → ApprovalGate · respuesta → ReplyDelivery.
 */
export class AgentRuntime {
  constructor(private readonly d: RuntimeDeps) {}

  /** Arranca un run en cola o lo retoma desde su checkpoint si un reintento lo encontró RUNNING. */
  async execute(workspaceId: string, runId: string, attempt = 0): Promise<void> {
    try {
      await this.executeInner(workspaceId, runId, attempt);
    } finally {
      await this.drainIfTerminal(workspaceId, runId);
    }
  }

  private async executeInner(workspaceId: string, runId: string, attempt: number): Promise<void> {
    const claimed = await this.d.runs.claim(workspaceId, runId, "QUEUED");
    const run = await this.d.runs.load(workspaceId, runId);
    if (!run || !(claimed || (run.status === "RUNNING" && attempt > 0))) return;
    if (!claimed && !(await this.d.runs.reclaim(run))) return; // otro proceso ya lo está recuperando

    if (run.conversation?.takenOverBy || run.conversation?.status === "HANDOFF") {
      await this.d.runs.finish(run, "CANCELLED", { error: "Conversación en manos de una persona" });
      return;
    }
    if (claimed) await this.d.runs.publish(run, "run.started", { agentId: run.agentId });
    const checkpoint = fromJson(run.checkpoint);
    if (checkpoint.length === 0) {
      // Un reintento (attempt > 0) vuelve a ejecutar el bucle: las tools ya hechas se deduplican.
      // N1 solo aplica al primer arranque, para no cancelar una recuperación con el checkpoint vacío.
      if (attempt === 0) {
        const prepared = await this.prepareInbound(run);
        if (prepared.skip) {
          await this.d.runs.finish(run, "CANCELLED", { error: "sin mensajes nuevos" });
          return;
        }
        return this.loop(run, prepared.messages);
      }
      return this.loop(run, await this.initialMessages(run));
    }
    if (claimed) return this.loop(run, checkpoint);
    // Recuperación tras caída del worker (reintento o barrido): si murió a mitad de una reanudación, el checkpoint
    // puede terminar en tool-calls aprobadas sin resultado. collect() las completa sin repetir lo ya ejecutado.
    const steps = await StepRecorder.for(this.d.db, run);
    const results = await this.d.gate.collect(run, checkpoint, steps);
    await this.loop(run, results.length ? appendToolResults(checkpoint, results) : checkpoint, steps);
  }

  /** Reanuda tras las decisiones de aprobación: añade los resultados al historial y continúa. */
  async resume(workspaceId: string, runId: string, attempt = 0): Promise<void> {
    try {
      await this.resumeInner(workspaceId, runId, attempt);
    } finally {
      await this.drainIfTerminal(workspaceId, runId);
    }
  }

  private async resumeInner(workspaceId: string, runId: string, attempt: number): Promise<void> {
    if ((await this.d.db.approval.count({ where: { workspaceId, runId, status: "PENDING" } })) > 0) return;
    const claimed = await this.d.runs.claim(workspaceId, runId, "WAITING_APPROVAL");
    const run = await this.d.runs.load(workspaceId, runId);
    if (!run || !(claimed || (run.status === "RUNNING" && attempt > 0))) return;
    if (!claimed && !(await this.d.runs.reclaim(run))) return;

    const steps = await StepRecorder.for(this.d.db, run);
    const messages = fromJson(run.checkpoint);
    const results = await this.d.gate.collect(run, messages, steps);
    await this.loop(run, appendToolResults(messages, results), steps);
  }

  private async loop(run: RunWithAgent, messages: ModelMessage[], existingSteps?: StepRecorder): Promise<void> {
    const steps = existingSteps ?? (await StepRecorder.for(this.d.db, run));
    // Latido mientras el run está vivo: el barrido de huérfanos solo reencola runs sin latido reciente (M12).
    const beat = setInterval(() => {
      this.d.runs.heartbeat(run.workspaceId, run.id).catch((err: unknown) => this.d.log.warn({ err, runId: run.id }, "latido fallido"));
    }, HEARTBEAT_MS);
    beat.unref();
    try {
      const resolved = await this.d.tools.resolveForAgent(run.workspaceId, (run.agent.toolConfig ?? {}) as AgentToolConfig, faceOf(run));
      const needsApproval = new Set(resolved.filter((t) => t.mode !== "NEVER").map((t) => toModelToolName(t.def.name)));
      let stepCount = run.stepCount;
      const abort = new AbortController();

      const result = streamText({
        model: await this.d.llm.resolve(run.workspaceId, run.agent.model),
        system: await this.systemPrompt(run),
        messages,
        tools: this.d.binder.bind(run, resolved, steps, () => stepCount),
        // Cancelación: se comprueba al acabar cada paso, antes de pedir el siguiente al modelo (no se gasta otra llamada).
        stopWhen: [stepCountIs(Math.max(1, this.d.maxSteps - run.stepCount)), () => this.d.runs.isCancelled(run.workspaceId, run.id)],
        abortSignal: abort.signal,
        onStepFinish: async (step) => {
          stepCount += 1;
          await this.d.runs.checkpoint(run.id, [...messages, ...step.response.messages], stepCount);
          await steps.record("llm", { data: { finishReason: step.finishReason, usage: step.usage, text: step.text } });
          if (await this.d.runs.isCancelled(run.workspaceId, run.id)) abort.abort(new Error("Run cancelado"));
        },
      });

      await this.streamDeltas(run, result.textStream);

      const [response, allSteps, usage] = await Promise.all([result.response, result.steps, result.totalUsage]);
      const finalMessages = [...messages, ...response.messages];
      const lastStep = allSteps.at(-1);
      const pending = (lastStep?.toolCalls ?? []).filter(
        (c) => needsApproval.has(c.toolName) && !lastStep?.toolResults.some((r) => r.toolCallId === c.toolCallId),
      );
      if (pending.length > 0) {
        await this.d.gate.request(run, finalMessages, pending, resolved, usage);
        return;
      }

      const text = (await result.text).trim();
      if (!text && lastStep?.finishReason === "tool-calls") {
        await this.d.runs.finish(run, "FAILED", { error: "Se alcanzó el máximo de pasos sin respuesta final", checkpoint: finalMessages, usage });
        return;
      }
      if (await this.d.runs.isCancelled(run.workspaceId, run.id)) return; // cancelado: no se entrega la respuesta
      await this.d.delivery.deliver(run, text);
      await this.d.runs.finish(run, "SUCCEEDED", { output: text, checkpoint: finalMessages, usage });
    } catch (err) {
      if (await this.d.runs.isCancelled(run.workspaceId, run.id).catch(() => false)) return;
      this.d.log.error({ err, runId: run.id }, "run failed");
      await this.d.runs.finish(run, "FAILED", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(beat);
    }
  }

  private async streamDeltas(run: RunWithAgent, stream: AsyncIterable<string>): Promise<void> {
    let buffer = "";
    let lastFlush = Date.now();
    const flush = async () => {
      if (!buffer) return;
      const delta = buffer;
      buffer = "";
      lastFlush = Date.now();
      await this.d.runs.publish(run, "message.delta", { delta });
    };
    for await (const delta of stream) {
      buffer += delta;
      if (buffer.length >= DELTA_FLUSH_CHARS || Date.now() - lastFlush >= DELTA_FLUSH_MS) await flush();
    }
    await flush();
  }

  private async systemPrompt(run: RunWithAgent): Promise<string> {
    const workspace = await this.d.db.workspace.findUniqueOrThrow({ where: { id: run.workspaceId } });
    const contactId = run.conversation?.contactId;
    const memories = contactId
      ? await this.d.db.memory.findMany({
          where: { workspaceId: run.workspaceId, contactId, OR: [{ agentId: run.agentId }, { agentId: null }] },
          orderBy: { updatedAt: "desc" },
          take: 20,
        })
      : [];
    return buildSystemPrompt({
      face: faceOf(run),
      agentName: run.agent.name,
      instructions: run.agent.instructions,
      timezone: workspace.timezone,
      now: new Date(),
      memories: memories.map((m) => ({ key: m.key, content: m.content })),
    });
  }

  /**
   * N1: un run de mensajes que arranca sin ningún entrante sin reclamar y cuyo último mensaje ya es saliente
   * no llama al modelo (el run anterior ya contestó). Los mensajes llegados durante una aprobación siguen
   * con runId null: se reclaman aquí y SÍ se contestan, aunque el saliente de la reanudación sea posterior.
   */
  private async prepareInbound(run: RunWithAgent): Promise<{ skip: boolean; messages: ModelMessage[] }> {
    const messages = await this.initialMessages(run);
    if (!run.conversationId || NOT_INBOUND.has(run.trigger)) return { skip: false, messages };
    const claimed = await this.d.db.message.updateMany({
      where: { workspaceId: run.workspaceId, conversationId: run.conversationId, direction: "INBOUND", runId: null },
      data: { runId: run.id },
    });
    if (claimed.count > 0) return { skip: false, messages };
    const last = await this.d.db.message.findFirst({
      where: { workspaceId: run.workspaceId, conversationId: run.conversationId },
      orderBy: { createdAt: "desc" },
      select: { direction: true },
    });
    return { skip: last?.direction !== "INBOUND", messages };
  }

  /** Suelta la cola de mensajes solo cuando este run ya está cerrado. */
  private async drainIfTerminal(workspaceId: string, runId: string): Promise<void> {
    const run = await this.d.runs.load(workspaceId, runId);
    if (!run?.conversationId || !TERMINAL.has(run.status)) return;
    await this.d.conversations.releaseQueued(workspaceId, run.conversationId);
  }

  private async initialMessages(run: RunWithAgent): Promise<ModelMessage[]> {
    if (run.conversationId) {
      const rows = await this.d.db.message.findMany({
        where: { workspaceId: run.workspaceId, conversationId: run.conversationId },
        orderBy: { createdAt: "desc" },
        take: HISTORY_LIMIT,
        select: { direction: true, text: true },
      });
      return historyToMessages(rows.reverse(), faceOf(run));
    }
    const input = run.input as { text?: string };
    return input.text ? [{ role: "user", content: input.text }] : [];
  }
}

export { faceOf };
