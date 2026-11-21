import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { upsertContactByChannel } from "../src/domain/contacts/service.js";
import { systemActor } from "../src/data/audit.js";
import { handleChannelInbound } from "../src/execution/workers/channel-inbound.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { ToolRegistry } from "../src/integrations/tools/registry.js";
import { builtinTools } from "../src/integrations/tools/builtin/index.js";
import { defineTool, type ToolDef } from "../src/integrations/tools/types.js";
import { RecordingQueue, resetDb, scriptedModel, seedAgent, seedWorkspace, testContext, type ScriptedTurn } from "./helpers.js";

const sendEmail = defineTool({
  name: "email.send",
  description: "Envía un correo",
  input: z.object({ to: z.string(), body: z.string() }),
  scope: "channel:send",
  risk: "send",
  approval: "ASK_OWNER",
  preview: (i) => `Enviar a ${i.to}`,
  async execute() {
    return { ok: true as const };
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

beforeEach(async () => {
  const { ctx } = setup([]);
  await resetDb(ctx);
});
afterAll(async () => {
  for (const c of contexts) await closeContext(c);
});

async function chat(ctx: AppContext, tools: string[] = []) {
  const ws = await ctx.db.workspace.create({ data: { name: "w", slug: `w-${Math.random().toString(36).slice(2)}` } });
  const agent = await seedAgent(ctx, ws.id, tools);
  const contact = await ctx.db.contact.create({ data: { workspaceId: ws.id, name: "Ana" } });
  const conv = await ctx.db.conversation.create({ data: { workspaceId: ws.id, agentId: agent.id, contactId: contact.id, channel: "api" } });
  return { ws, agent, conv };
}

describe("D1 · mensajes durante una aprobación", () => {
  it("(a)(b) no hay llamadas hasta la decisión; después se reanuda y la cola sale en una sola llamada", async () => {
    const { ctx, queue, scripted } = setup([
      { toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com", body: "x" } }] },
      { text: "Enviado." },
      { text: "Mañana también, anotado." },
    ]);
    const { ws, conv } = await chat(ctx, ["email.send"]);
    const first = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: conv.id, text: "Reserva hoy", author: "CONTACT", trigger: "api.chat" });
    if (first.status !== "run_queued") throw new Error(first.status);
    await ctx.runtime.execute(ws.id, first.runId);
    expect(scripted.calls()).toBe(1);

    const queued = await ctx.conversations.receive({
      workspaceId: ws.id,
      conversationId: conv.id,
      text: "mejor mañana",
      author: "CONTACT",
      trigger: "api.chat",
    });
    const queued2 = await ctx.conversations.receive({
      workspaceId: ws.id,
      conversationId: conv.id,
      text: "por favor",
      author: "CONTACT",
      trigger: "channel.inbound",
    });
    expect(queued.status).toBe("queued_behind_approval");
    expect(queued2.status).toBe("queued_behind_approval");
    expect(scripted.calls()).toBe(1);
    expect(await ctx.db.run.count({ where: { conversationId: conv.id } })).toBe(1);

    const approval = await ctx.db.approval.findFirstOrThrow({ where: { runId: first.runId } });
    await ctx.approvals.decide(ws.id, approval.id, "APPROVED", systemActor);
    await ctx.runtime.resume(ws.id, first.runId);
    expect(scripted.calls()).toBe(2);

    const follow = queue.jobs.filter(
      (j) => j.name === "run.process" && (j.data as { kind: string }).kind === "execute" && (j.data as { runId: string }).runId !== first.runId,
    );
    expect(follow).toHaveLength(1);
    await ctx.runtime.execute(ws.id, (follow[0]!.data as { runId: string }).runId);
    expect(scripted.calls()).toBe(3);
    const outs = await ctx.db.message.findMany({ where: { conversationId: conv.id, direction: "OUTBOUND" } });
    expect(outs.map((m) => m.text)).toEqual(["Enviado.", "Mañana también, anotado."]);
  });

  it("(c) dos mensajes seguidos, sin aprobación, producen una sola llamada", async () => {
    const { ctx, queue, scripted } = setup([{ text: "Hola a los dos" }]);
    const { ws, conv } = await chat(ctx);
    const a = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: conv.id, text: "hola", author: "CONTACT", trigger: "api.chat" });
    const b = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: conv.id, text: "¿sigues ahí?", author: "CONTACT", trigger: "api.chat" });
    expect(a.status).toBe("run_queued");
    expect(b.status).toBe("coalesced");
    expect(queue.jobs.filter((j) => j.name === "run.process")).toHaveLength(1);
    if (a.status !== "run_queued") throw new Error("no");
    await ctx.runtime.execute(ws.id, a.runId);
    expect(scripted.calls()).toBe(1);
    expect(await ctx.db.message.count({ where: { conversationId: conv.id, direction: "OUTBOUND" } })).toBe(1);
    expect(Number((await ctx.db.run.findUniqueOrThrow({ where: { id: a.runId } })).costUsd)).toBeGreaterThan(0);
  });

  it("(d) el rechazo y la caducidad también sueltan la cola", async () => {
    for (const mode of ["reject", "expire"] as const) {
      const { ctx, queue, scripted } = setup([
        { toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com", body: "x" } }] },
        { text: mode === "reject" ? "No lo envío." : "Caducó." },
        { text: "Sigo con lo que escribiste." },
      ]);
      const { ws, conv } = await chat(ctx, ["email.send"]);
      const first = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: conv.id, text: "hola", author: "CONTACT", trigger: "api.chat" });
      if (first.status !== "run_queued") throw new Error(first.status);
      await ctx.runtime.execute(ws.id, first.runId);
      await ctx.conversations.receive({ workspaceId: ws.id, conversationId: conv.id, text: "otra cosa", author: "CONTACT", trigger: "api.chat" });
      const approval = await ctx.db.approval.findFirstOrThrow({ where: { runId: first.runId } });
      if (mode === "reject") await ctx.approvals.decide(ws.id, approval.id, "REJECTED", systemActor, "no");
      else {
        await ctx.db.approval.updateMany({ where: { id: approval.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect(await ctx.approvals.expireDue()).toBe(1);
      }
      await ctx.runtime.resume(ws.id, first.runId);
      const follow = queue.jobs.filter((j) => (j.data as { runId?: string }).runId && (j.data as { runId: string }).runId !== first.runId);
      expect(follow).toHaveLength(1);
      await ctx.runtime.execute(ws.id, (follow[0]!.data as { runId: string }).runId);
      expect(scripted.calls()).toBe(3);
    }
  });
});

describe("N1 · un segundo run sin entrantes nuevos no llama al modelo", () => {
  it("cancela con «sin mensajes nuevos»", async () => {
    const { ctx, scripted } = setup([{ text: "uno" }, { text: "no debe salir" }]);
    const { ws, agent, conv } = await chat(ctx);
    const first = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: conv.id, text: "hola", author: "CONTACT", trigger: "api.chat" });
    if (first.status !== "run_queued") throw new Error(first.status);
    const extra = await ctx.db.run.create({
      data: { workspaceId: ws.id, agentId: agent.id, agentVersion: agent.version, conversationId: conv.id, trigger: "api.chat", input: {} },
    });
    await ctx.runtime.execute(ws.id, first.runId);
    await ctx.runtime.execute(ws.id, extra.id);
    expect(scripted.calls()).toBe(1);
    const second = await ctx.db.run.findUniqueOrThrow({ where: { id: extra.id } });
    expect(second.status).toBe("CANCELLED");
    expect(second.error).toBe("sin mensajes nuevos");
  });
});

describe("D2 · una sola key de Composio", () => {
  it("rechaza apiKey en la conexión y /ready informa deshabilitado sin filtrar secretos", async () => {
    const { ctx } = setup([]);
    const app: FastifyInstance = await buildApp(ctx);
    const ws = await ctx.db.workspace.create({ data: { name: "c", slug: `c-${Math.random().toString(36).slice(2)}` } });
    await expect(
      ctx.connections.create(ws.id, { kind: "composio", name: "c", secret: { apiKey: "k-1234567890" }, config: { tools: [] } }, systemActor),
    ).rejects.toThrow(/COMPOSIO_API_KEY/);
    const created = await ctx.connections.create(ws.id, { kind: "composio", name: "c", config: { tools: [] } }, systemActor);
    expect(created.secretEnc).toBeNull();
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.json()).toMatchObject({ composio: "disabled" });
    expect(JSON.stringify(ready.json())).not.toMatch(/k-1234567890|COMPOSIO_API_KEY=/);
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("ega_runs_finished_total");
    await app.close();
  });
});

describe("N2 · identidad única de contacto", () => {
  it("ocho altas simultáneas del mismo WhatsApp dejan un solo contacto", async () => {
    const { ctx } = setup([]);
    const ws = await ctx.db.workspace.create({ data: { name: "n", slug: `n-${Math.random().toString(36).slice(2)}` } });
    await Promise.all(
      Array.from({ length: 8 }, () => upsertContactByChannel(ctx.db, { workspaceId: ws.id, channel: "whatsapp", externalId: "34600000000", name: "Ana" })),
    );
    expect(await ctx.db.contact.count({ where: { workspaceId: ws.id } })).toBe(1);
    expect(await ctx.db.contactIdentity.count({ where: { workspaceId: ws.id, channel: "whatsapp", externalId: "34600000000" } })).toBe(1);
  });
});

describe("N3 · inbox y contactos", () => {
  it("lista, toma, responde y suelta; un workspace no ve al otro", async () => {
    const { ctx } = setup([]);
    const app = await buildApp(ctx);
    const a = await seedWorkspace(ctx, `ia-${Math.random().toString(36).slice(2)}`);
    const b = await seedWorkspace(ctx, `ib-${Math.random().toString(36).slice(2)}`);
    const agent = await seedAgent(ctx, a.workspace.id);
    const conv = await ctx.db.conversation.create({ data: { workspaceId: a.workspace.id, agentId: agent.id, channel: "whatsapp", status: "OPEN" } });
    await ctx.db.message.create({
      data: { workspaceId: a.workspace.id, conversationId: conv.id, direction: "INBOUND", author: "CONTACT", text: "necesito una persona", status: "RECEIVED" },
    });

    const list = await app.inject({ method: "GET", url: "/v1/conversations?status=OPEN", headers: a.auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].preview).toBe("necesito una persona");
    expect((await app.inject({ method: "GET", url: "/v1/conversations?status=HANDOFF", headers: a.auth })).json().data).toHaveLength(0);

    const taken = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/takeover`, headers: a.auth });
    expect(taken.statusCode).toBe(200);
    expect(taken.json().status).toBe("HANDOFF");
    expect((await app.inject({ method: "GET", url: "/v1/conversations?status=HANDOFF", headers: a.auth })).json().data).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/takeover`, headers: b.auth })).statusCode).toBe(404);

    const reply = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/reply`, headers: a.auth, payload: { text: "Te atiendo yo" } });
    expect(reply.statusCode).toBe(201);
    const released = await app.inject({ method: "POST", url: `/v1/conversations/${conv.id}/release`, headers: a.auth });
    expect(released.json().status).toBe("OPEN");

    const contact = await app.inject({ method: "POST", url: "/v1/contacts", headers: a.auth, payload: { name: "Luis", phone: "+34 600 111 222" } });
    expect(contact.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/v1/contacts", headers: b.auth })).json().data).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/v1/contacts/${contact.json().id}`, headers: a.auth })).statusCode).toBe(200);
    await app.close();
  });
});

describe("N4 · dos números no comparten conversación", () => {
  it("el mismo hilo en dos conexiones son dos conversaciones; repetir una no duplica", async () => {
    const { ctx } = setup([]);
    const ws = await ctx.db.workspace.create({ data: { name: "ch", slug: `ch-${Math.random().toString(36).slice(2)}` } });
    const agent = await seedAgent(ctx, ws.id);
    const mk = (name: string) =>
      ctx.db.connection.create({
        data: { workspaceId: ws.id, kind: "channel.whatsapp_cloud", name, status: "OK", config: { agentId: agent.id } },
      });
    const c1 = await mk("uno");
    const c2 = await mk("dos");
    const inbound = (connectionId: string, id: string) =>
      handleChannelInbound(ctx, {
        workspaceId: ws.id,
        connectionId,
        channel: "whatsapp",
        externalThreadId: "34611111111",
        channelMessageId: id,
        from: { id: "34611111111", phone: "34611111111", name: "Ana" },
        text: "hola",
        receivedAt: new Date().toISOString(),
      });
    await inbound(c1.id, "m1");
    await inbound(c2.id, "m2");
    await inbound(c1.id, "m3");
    const convs = await ctx.db.conversation.findMany({ where: { workspaceId: ws.id } });
    expect(convs).toHaveLength(2);
    expect(new Set(convs.map((c) => c.connectionId))).toEqual(new Set([c1.id, c2.id]));
    expect(await ctx.db.run.count({ where: { workspaceId: ws.id } })).toBe(2);
  });
});

describe("agenda, leads, rutinas y secuencias", () => {
  it("reserva un hueco, mueve un lead, dispara una rutina y ejecuta un paso de secuencia", async () => {
    const { ctx, queue } = setup([]);
    const ws = await ctx.db.workspace.create({ data: { name: "m", slug: `m-${Math.random().toString(36).slice(2)}` } });
    const agent = await seedAgent(ctx, ws.id, ["agenda.slots", "lead.create"]);
    const contact = await ctx.db.contact.create({ data: { workspaceId: ws.id, name: "Ana" } });
    const hours = Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((d) => [d, [["00:00", "23:59"]]]));
    const cal = await ctx.agenda.createCalendar(
      ws.id,
      { name: "Recepción", timezone: "Europe/Madrid", slotMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 0, maxDaysAhead: 7, hours, reminderMinutes: 0 },
      systemActor,
    );
    const from = new Date(Date.now() + 60 * 60_000);
    const slots = await ctx.agenda.slots(ws.id, cal.id, { from, to: new Date(from.getTime() + 24 * 60 * 60_000) }, { limit: 1 });
    expect(slots.length).toBeGreaterThan(0);
    const appt = await ctx.agenda.book(ws.id, { calendarId: cal.id, startsAt: slots[0]!.startsAt, title: "Visita", contactId: contact.id }, systemActor);
    expect(appt.status).toBe("BOOKED");

    const lead = await ctx.leads.create(ws.id, { contactId: contact.id, title: "Presupuesto" }, systemActor);
    const moved = await ctx.leads.update(ws.id, lead.id, { stage: "Contactado" }, systemActor);
    expect(moved.stage.name).toBe("Contactado");

    const routine = await ctx.routines.create(
      ws.id,
      { agentId: agent.id, name: "Resumen", cron: "0 9 * * 1-5", instruction: "Resume el día", enabled: true },
      systemActor,
    );
    await ctx.db.routine.update({ where: { id: routine.id }, data: { lastRunAt: null } });
    expect(await ctx.routines.tick()).toBeGreaterThanOrEqual(1);

    const conv = await ctx.db.conversation.create({ data: { workspaceId: ws.id, agentId: agent.id, contactId: contact.id, channel: "api" } });
    const seq = await ctx.sequences.create(
      ws.id,
      { name: "Seguimiento", steps: [{ kind: "message", delayMinutes: 0, text: "Hola {{contact.name}}" }], stopOnReply: true, active: true },
      systemActor,
    );
    const enrollment = await ctx.sequences.enroll(ws.id, seq.id, conv.id, systemActor);
    await ctx.sequences.runStep(ws.id, enrollment.id, 0);
    const out = await ctx.db.message.findFirst({ where: { conversationId: conv.id, direction: "OUTBOUND" } });
    expect(out?.text).toBe("Hola Ana");
    expect(queue.jobs.some((j) => j.name === "run.process" && (j.data as { trigger?: string }).trigger === undefined)).toBe(true);
  });
});
