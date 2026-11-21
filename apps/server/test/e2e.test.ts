import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../src/shared/config/env.js";
import { closeContext, createContext, type AppContext } from "../src/container.js";
import { buildApp } from "../src/access/http/app.js";
import { startWorkers } from "../src/execution/workers/index.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { resetDb, scriptedModel, seedAgent, seedWorkspace, waitFor } from "./helpers.js";

/**
 * Flujo "Chat desde la UI" del diagrama con piezas reales:
 * A POST /v1/chats/:id/messages → B run.process en pg-boss (grupo = conversación) → C worker ejecuta el run
 * → D eventos en la tabla Event + NOTIFY → E streaming SSE al cliente.
 */
let ctx: AppContext;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  const scripted = scriptedModel([{ text: "Hola, soy tu agente. ¿Qué necesitas?" }]);
  ctx = createContext(loadEnv(process.env), { llm: new StaticLlmResolver(scripted.model) });
  await resetDb(ctx);
  await ctx.boss!.start();
  await ctx.bus.start();
  await startWorkers(ctx);
  app = await buildApp(ctx);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await closeContext(ctx);
});

async function readSse(url: string, headers: Record<string, string>, until: string): Promise<Array<{ id: string; event: string; data: unknown }>> {
  const res = await fetch(url, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id: string; event: string; data: unknown }> = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.startsWith(":")) continue;
      const get = (k: string) =>
        block
          .split("\n")
          .find((l) => l.startsWith(`${k}: `))
          ?.slice(k.length + 2) ?? "";
      events.push({ id: get("id"), event: get("event"), data: JSON.parse(get("data") || "null") });
      if (get("event") === until) {
        await reader.cancel();
        return events;
      }
    }
  }
  return events;
}

describe("e2e: chat desde la UI", () => {
  it("mensaje → cola → worker → eventos → SSE", async () => {
    const w = await seedWorkspace(ctx, "e2e");
    const agent = await seedAgent(ctx, w.workspace.id);
    const headers = { ...w.auth, "content-type": "application/json" };

    const chat = await (await fetch(`${baseUrl}/v1/chats`, { method: "POST", headers, body: JSON.stringify({ agentId: agent.id }) })).json();
    const accepted = await fetch(`${baseUrl}/v1/chats/${chat.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "Hola" }) });
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json();

    const events = await readSse(`${baseUrl}/v1/runs/${runId}/events`, w.auth, "run.finished");
    const types = events.map((e) => e.event);
    const finished = events.at(-1)?.data;
    expect(finished, JSON.stringify(events)).toEqual({ status: "SUCCEEDED" });
    expect(types[0]).toBe("run.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("message.completed");
    expect(types.at(-1)).toBe("run.finished");
    expect(events.at(-1)!.data).toEqual({ status: "SUCCEEDED" });
    // ids crecientes (sirven como Last-Event-ID para reconectar)
    const ids = events.map((e) => BigInt(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));

    // Reconexión con Last-Event-ID: solo llega lo posterior.
    const resumeFrom = events[1]!.id;
    const replay = await readSse(`${baseUrl}/v1/runs/${runId}/events`, { ...w.auth, "last-event-id": resumeFrom }, "run.finished");
    expect(replay.every((e) => BigInt(e.id) > BigInt(resumeFrom))).toBe(true);

    const run = await waitFor(async () => {
      const r = await (await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: w.auth })).json();
      return r.status === "SUCCEEDED" ? r : null;
    });
    expect(run.output).toBe("Hola, soy tu agente. ¿Qué necesitas?");

    const messages = await (await fetch(`${baseUrl}/v1/chats/${chat.id}/messages`, { headers: w.auth })).json();
    expect(messages.data.map((m: { direction: string }) => m.direction)).toEqual(["INBOUND", "OUTBOUND"]);
  });

  it("el SSE de un run de otro workspace devuelve 404", async () => {
    const a = await seedWorkspace(ctx, "sse-a");
    const b = await seedWorkspace(ctx, "sse-b");
    const agentB = await seedAgent(ctx, b.workspace.id);
    const run = await ctx.db.run.create({ data: { workspaceId: b.workspace.id, agentId: agentB.id, agentVersion: 1, trigger: "test" } });
    const res = await fetch(`${baseUrl}/v1/runs/${run.id}/events`, { headers: a.auth });
    expect(res.status).toBe(404);
  });
});
