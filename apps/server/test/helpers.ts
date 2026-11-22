import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { loadEnv } from "../src/shared/config/env.js";
import { createContext, type AppContext, type ContextOverrides } from "../src/container.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { SCOPES, type Scope } from "../src/access/auth/scopes.js";
import { MemoryJobPort } from "../src/execution/queue/ports.js";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

export type ScriptedTurn = { text: string } | { toolCalls: Array<{ id: string; name: string; input: unknown }> };

/** Modelo simulado: cada llamada al modelo consume el siguiente turno del guion. */
export function scriptedModel(turns: ScriptedTurn[]) {
  let i = 0;
  const requests: Array<{ tools?: Array<{ name: string }>; prompt: unknown }> = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      requests.push(options as unknown as { tools?: Array<{ name: string }>; prompt: unknown });
      const turn = turns[i++] ?? { text: "(fin del guion)" };
      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if ("text" in turn) {
        chunks.push({ type: "text-start", id: "t" });
        for (const word of turn.text.split(/(?<= )/)) chunks.push({ type: "text-delta", id: "t", delta: word });
        chunks.push({ type: "text-end", id: "t" });
        chunks.push({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage });
      } else {
        for (const c of turn.toolCalls) chunks.push({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.input) });
        chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
      }
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
  return { model, calls: () => i, requests };
}

/** Cola falsa que registra los jobs enviados (para tests sin workers). */
/** Cola de tests: el adaptador en memoria del puerto de jobs (ADR 004). */
export class RecordingQueue extends MemoryJobPort {}

export function testContext(overrides: ContextOverrides = {}): AppContext {
  return createContext(loadEnv(process.env), { queue: new RecordingQueue(), llm: new StaticLlmResolver(scriptedModel([{ text: "ok" }]).model), ...overrides });
}

export async function resetDb(ctx: AppContext): Promise<void> {
  const dbName = new URL(ctx.env.DATABASE_URL).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) throw new Error(`resetDb solo se permite en bases *_test (recibido: "${dbName}")`);
  const tables = await ctx.db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await ctx.db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export async function seedWorkspace(ctx: AppContext, slug: string, scopes: Scope[] = [...SCOPES]) {
  const workspace = await ctx.db.workspace.create({ data: { name: slug, slug } });
  const key = await ctx.apiKeys.issue({ workspaceId: workspace.id, name: "test", scopes });
  return { workspace, token: key.token, auth: { authorization: `Bearer ${key.token}` } };
}

export async function seedAgent(ctx: AppContext, workspaceId: string, tools: string[] = [], approvals: Record<string, string> = {}) {
  return ctx.db.agent.create({
    data: { workspaceId, name: "Recepción", instructions: "Atiende a los clientes.", model: "test:mock", toolConfig: { tools, approvals } },
  });
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: tiempo agotado");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** E4: un OWNER baja send/money a directo en la política de riesgo del workspace (para tests de tools de envío). */
export async function allowDirectSend(ctx: AppContext, workspaceId: string): Promise<void> {
  const ws = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  await ctx.db.workspace.update({ where: { id: workspaceId }, data: { settings: { ...settings, riskPolicy: { send: "direct", money: "direct" } } } });
}
