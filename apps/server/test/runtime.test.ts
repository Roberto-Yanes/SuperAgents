import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeContext, type AppContext } from "../src/container.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { ToolRegistry } from "../src/integrations/tools/registry.js";
import { builtinTools } from "../src/integrations/tools/builtin/index.js";
import { defineTool, type ToolDef } from "../src/integrations/tools/types.js";
import { systemActor } from "../src/data/audit.js";
import { RecordingQueue, resetDb, scriptedModel, seedAgent, testContext, type ScriptedTurn } from "./helpers.js";
import { allowDirectSend } from "./helpers.js";

/** Tool externa simulada con aprobación del dueño: cuenta cuántas veces se ejecuta de verdad. */
let sent: Array<{ to: string; idem: string }> = [];
const sendEmail = defineTool({
  name: "email.send",
  description: "Envía un correo",
  input: z.object({ to: z.string(), body: z.string() }),
  scope: "channel:send",
  risk: "send",
  approval: "ASK_OWNER",
  preview: (i) => `Enviar a ${i.to}: ${i.body}`,
  async execute(i, ctx) {
    sent.push({ to: i.to, idem: ctx.idempotencyKey });
    return { ok: true, messageId: `m-${sent.length}` };
  },
});

const contexts: AppContext[] = [];
function setup(turns: ScriptedTurn[]) {
  const queue = new RecordingQueue();
  const tools = new ToolRegistry();
  for (const t of [...builtinTools, sendEmail as ToolDef]) tools.register(t);
  const scripted = scriptedModel(turns);
  const ctx = testContext({ queue, tools, llm: new StaticLlmResolver(scripted.model) });
  contexts.push(ctx);
  return { ctx, queue, scripted };
}

async function startChat(ctx: AppContext, tools: string[], approvals: Record<string, string> = {}) {
  const ws = await ctx.db.workspace.create({ data: { name: "w", slug: `w-${Date.now()}-${Math.random()}` } });
  const agent = await seedAgent(ctx, ws.id, tools, approvals);
  const contact = await ctx.db.contact.create({ data: { workspaceId: ws.id, name: "Ana" } });
  const chat = await ctx.db.conversation.create({ data: { workspaceId: ws.id, agentId: agent.id, contactId: contact.id, channel: "api" } });
  const r = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: chat.id, text: "Hola", author: "CONTACT", trigger: "test" });
  if (r.status !== "run_queued") throw new Error("run no encolado");
  return { ws, agent, contact, chat, runId: r.runId };
}

beforeEach(async () => {
  sent = [];
  const { ctx } = setup([]);
  await resetDb(ctx);
});
afterAll(async () => {
  for (const c of contexts) await closeContext(c);
});

describe("agent runtime", () => {
  it("respuesta simple: run SUCCEEDED, mensaje saliente y eventos delta → completed → finished", async () => {
    const { ctx } = setup([{ text: "¡Hola Ana! ¿En qué te ayudo?" }]);
    const { ws, chat, runId } = await startChat(ctx, []);
    await ctx.runtime.execute(ws.id, runId);

    const run = await ctx.db.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("SUCCEEDED");
    expect(run.output).toBe("¡Hola Ana! ¿En qué te ayudo?");
    const out = await ctx.db.message.findFirst({ where: { conversationId: chat.id, direction: "OUTBOUND" } });
    expect(out?.text).toBe(run.output);
    expect(out?.status).toBe("SENT"); // canal api: sin envío externo

    const events = await ctx.db.event.findMany({ where: { subject: `run:${runId}` }, orderBy: { seq: "asc" } });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("message.delta");
    expect(types.at(-2)).toBe("message.completed");
    expect(types.at(-1)).toBe("run.finished");
    const deltas = events
      .filter((e) => e.type === "message.delta")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(deltas).toBe(run.output);
  });

  it("tool automática (NEVER) se ejecuta en el bucle y queda registrada", async () => {
    const { ctx } = setup([{ toolCalls: [{ id: "c1", name: "memory__save", input: { key: "alergia", content: "frutos secos" } }] }, { text: "Anotado." }]);
    const { ws, contact, runId } = await startChat(ctx, ["memory.save"]);
    await ctx.runtime.execute(ws.id, runId);
    expect((await ctx.db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("SUCCEEDED");
    const mem = await ctx.db.memory.findFirst({ where: { workspaceId: ws.id, contactId: contact.id, key: "alergia" } });
    expect(mem?.content).toBe("frutos secos");
    const steps = await ctx.db.runStep.findMany({ where: { runId }, orderBy: { index: "asc" } });
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "llm", "llm"]);
  });

  it("ASK_OWNER: pausa en WAITING_APPROVAL; al aprobar se ejecuta UNA vez y el run continúa", async () => {
    const { ctx, queue, scripted } = setup([
      { toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com", body: "Presupuesto adjunto" } }] },
      { text: "Listo, enviado." },
    ]);
    const { ws, runId } = await startChat(ctx, ["email.send"]);
    await ctx.runtime.execute(ws.id, runId);

    let run = await ctx.db.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("WAITING_APPROVAL");
    expect(sent).toHaveLength(0);
    const approval = await ctx.db.approval.findFirstOrThrow({ where: { runId } });
    expect(approval.status).toBe("PENDING");
    expect(approval.preview).toBe("Enviar a ana@x.com: Presupuesto adjunto");
    expect(approval.mode).toBe("ASK_OWNER");

    await ctx.approvals.decide(ws.id, approval.id, "APPROVED", systemActor);
    await expect(ctx.approvals.decide(ws.id, approval.id, "APPROVED", systemActor)).rejects.toMatchObject({ code: "approval_not_pending" });
    const resumes = queue.take("run.process").filter((j) => (j.data as { kind: string }).kind === "resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.data).toMatchObject({ runId, kind: "resume" });

    await ctx.runtime.resume(ws.id, runId);
    await ctx.runtime.resume(ws.id, runId); // segundo resume: no hace nada
    run = await ctx.db.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("SUCCEEDED");
    expect(run.output).toBe("Listo, enviado.");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idem).toBe(approval.idempotencyKey);
    expect((await ctx.db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("EXECUTED");
    expect(scripted.calls()).toBe(2);
  });

  it("rechazo: la tool no se ejecuta y el modelo recibe el rechazo", async () => {
    const { ctx } = setup([{ toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com", body: "x" } }] }, { text: "Entendido, no lo envío." }]);
    const { ws, runId } = await startChat(ctx, ["email.send"]);
    await ctx.runtime.execute(ws.id, runId);
    const approval = await ctx.db.approval.findFirstOrThrow({ where: { runId } });
    await ctx.approvals.decide(ws.id, approval.id, "REJECTED", systemActor, "No quiero");
    await ctx.runtime.resume(ws.id, runId);
    const run = await ctx.db.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("SUCCEEDED");
    expect(sent).toHaveLength(0);
    const checkpoint = JSON.stringify(run.checkpoint);
    expect(checkpoint).toContain("rechazó");
  });

  it("override del agente: ASK_OWNER → NEVER se ejecuta sin aprobación", async () => {
    const { ctx } = setup([{ toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com", body: "x" } }] }, { text: "Enviado." }]);
    const { ws, runId } = await startChat(ctx, ["email.send"], { "email.send": "NEVER" });
    await allowDirectSend(ctx, ws.id); // E4: send pide aprobación salvo que un OWNER lo baje
    await ctx.runtime.execute(ws.id, runId);
    expect((await ctx.db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("SUCCEEDED");
    expect(sent).toHaveLength(1);
    expect(await ctx.db.approval.count({ where: { runId } })).toBe(0);
  });

  it("caducidad: la aprobación vence sola y el run continúa sin ejecutar la acción", async () => {
    const { ctx, queue } = setup([
      { toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com", body: "x" } }] },
      { text: "No hubo respuesta del dueño." },
    ]);
    const { ws, runId } = await startChat(ctx, ["email.send"]);
    await ctx.runtime.execute(ws.id, runId);
    await ctx.db.approval.updateMany({ where: { runId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await ctx.approvals.expireDue()).toBe(1);
    expect(queue.take("run.process").filter((j) => (j.data as { kind: string }).kind === "resume")).toHaveLength(1);
    await ctx.runtime.resume(ws.id, runId);
    expect((await ctx.db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("SUCCEEDED");
    expect(sent).toHaveLength(0);
  });

  it("takeover humano: no se crea run y el agente no responde", async () => {
    const { ctx, queue } = setup([{ text: "no debería salir" }]);
    const ws = await ctx.db.workspace.create({ data: { name: "t", slug: "t" } });
    const agent = await seedAgent(ctx, ws.id);
    const chat = await ctx.db.conversation.create({ data: { workspaceId: ws.id, agentId: agent.id, channel: "api", takenOverBy: "user-1" } });
    const r = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: chat.id, text: "Hola", author: "CONTACT", trigger: "test" });
    expect(r.status).toBe("human_handling");
    expect(queue.jobs).toHaveLength(0);
    expect(await ctx.db.run.count()).toBe(0);
  });

  it("mensaje de canal duplicado (mismo channelMessageId) no crea otro run", async () => {
    const { ctx, queue } = setup([]);
    const ws = await ctx.db.workspace.create({ data: { name: "d", slug: "d" } });
    const agent = await seedAgent(ctx, ws.id);
    const chat = await ctx.db.conversation.create({ data: { workspaceId: ws.id, agentId: agent.id, channel: "whatsapp", externalThreadId: "346" } });
    const input = {
      workspaceId: ws.id,
      conversationId: chat.id,
      text: "Hola",
      author: "CONTACT" as const,
      channelMessageId: "wamid.1",
      trigger: "channel.inbound",
    };
    expect((await ctx.conversations.receive(input)).status).toBe("run_queued");
    expect((await ctx.conversations.receive(input)).status).toBe("duplicate");
    expect(queue.jobs.filter((j) => j.name === "run.process")).toHaveLength(1);
  });
});
