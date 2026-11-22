import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { RecordingQueue, resetDb, seedAgent, seedWorkspace, testContext } from "./helpers.js";

/** RGPD (ADR 005, E8): exportar y borrar un contacto, y retención configurable. */
let ctx: AppContext;
let app: FastifyInstance;
beforeAll(async () => {
  ctx = testContext({ queue: new RecordingQueue() });
  await resetDb(ctx);
  app = await buildApp(ctx);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeContext(ctx);
});

async function seedPerson(workspaceId: string, name: string, phone: string) {
  const agent = await seedAgent(ctx, workspaceId);
  const contact = await ctx.db.contact.create({ data: { workspaceId, name, phone } });
  await ctx.db.contactIdentity.create({ data: { workspaceId, contactId: contact.id, channel: "whatsapp", externalId: phone } });
  const conv = await ctx.db.conversation.create({
    data: { workspaceId, agentId: agent.id, contactId: contact.id, channel: "whatsapp", externalThreadId: phone },
  });
  await ctx.db.message.createMany({
    data: [
      { workspaceId, conversationId: conv.id, direction: "INBOUND", author: "CONTACT", text: `Hola, soy ${name}, tengo dolor de muelas`, status: "RECEIVED" },
      { workspaceId, conversationId: conv.id, direction: "OUTBOUND", author: "AGENT", text: "Te busco hueco", status: "SENT" },
    ],
  });
  const task = await ctx.db.task.create({
    data: {
      workspaceId,
      agentId: agent.id,
      goal: "Atender",
      source: "CHANNEL",
      launchedBy: "channel",
      conversationId: conv.id,
      contactId: contact.id,
      limits: {},
    },
  });
  const run = await ctx.db.run.create({
    data: { workspaceId, agentId: agent.id, agentVersion: 1, conversationId: conv.id, taskId: task.id, trigger: "channel.inbound", status: "SUCCEEDED" },
  });
  await ctx.db.runStep.create({ data: { workspaceId, runId: run.id, index: 0, kind: "llm", data: { text: `Hola ${name}` } } });
  await ctx.db.event.create({ data: { workspaceId, type: "message.created", subject: `conversation:${conv.id}`, data: { text: `Hola, soy ${name}` } } });
  await ctx.db.memory.create({ data: { workspaceId, agentId: agent.id, contactId: contact.id, key: "preferencia", content: "Prefiere tardes" } });
  const stages = await ctx.leads.stages(workspaceId);
  await ctx.db.lead.create({ data: { workspaceId, contactId: contact.id, title: `Implante ${name}`, stageId: stages[0]!.id } });
  const cal = await ctx.db.calendar.create({ data: { workspaceId, name: `Agenda ${name}`, timezone: "Europe/Madrid", hours: {} } });
  await ctx.db.appointment.create({
    data: {
      workspaceId,
      calendarId: cal.id,
      contactId: contact.id,
      conversationId: conv.id,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
      title: `Cita ${name}`,
    },
  });
  return { agent, contact, conv, task, run };
}

describe("Exportar y borrar un contacto", () => {
  it("exporta mensajes, memoria, leads, citas y tareas; el borrado lo quita todo, tacha las notas y deja a los demás", async () => {
    const w = await seedWorkspace(ctx, `p-${Date.now()}`);
    const ana = await seedPerson(w.workspace.id, "Ana Pérez", "34600111222");
    const luis = await seedPerson(w.workspace.id, "Luis Gómez", "34600333444");
    await ctx.db.memory.create({
      data: {
        workspaceId: w.workspace.id,
        agentId: ana.agent.id,
        contactId: null,
        key: "seguimiento",
        content: "Llamar a Ana Pérez (34600111222) el lunes; Luis Gómez también.",
      },
    });
    const appTask = await ctx.db.task.create({
      data: {
        workspaceId: w.workspace.id,
        agentId: ana.agent.id,
        goal: "Revisar presupuestos",
        source: "APP",
        launchedBy: "user:x",
        contactId: ana.contact.id,
        limits: {},
      },
    });

    const exp = await app.inject({ method: "GET", url: `/v1/contacts/${ana.contact.id}/export`, headers: w.auth });
    expect(exp.statusCode).toBe(200);
    const data = exp.json();
    expect(data.contact).toMatchObject({ name: "Ana Pérez", phone: "34600111222" });
    expect(data.conversations[0].messages).toHaveLength(2);
    expect(data.memories).toEqual([expect.objectContaining({ key: "preferencia" })]);
    expect(data.leads).toHaveLength(1);
    expect(data.appointments).toHaveLength(1);
    expect(data.tasks.map((t: { id: string }) => t.id).sort()).toEqual([ana.task.id, appTask.id].sort());
    expect(JSON.stringify(data)).not.toContain("Luis");

    expect((await app.inject({ method: "POST", url: `/v1/contacts/${ana.contact.id}/erase`, headers: w.auth, payload: {} })).statusCode).toBe(400); // exige confirm
    const er = await app.inject({ method: "POST", url: `/v1/contacts/${ana.contact.id}/erase`, headers: w.auth, payload: { confirm: true } });
    expect(er.statusCode).toBe(200);
    expect(er.json().counts).toMatchObject({
      conversations: 1,
      messages: 2,
      runs: 1,
      tasks: 1,
      events: 1,
      appointments: 1,
      memories: 1,
      leads: 1,
      notesRedacted: 1,
      appTasksUnlinked: 1,
    });

    const ws = w.workspace.id;
    expect(await ctx.db.contact.count({ where: { id: ana.contact.id } })).toBe(0);
    expect(await ctx.db.contactIdentity.count({ where: { workspaceId: ws, externalId: "34600111222" } })).toBe(0);
    expect(await ctx.db.conversation.count({ where: { id: ana.conv.id } })).toBe(0);
    expect(await ctx.db.message.count({ where: { conversationId: ana.conv.id } })).toBe(0);
    expect(await ctx.db.run.count({ where: { id: ana.run.id } })).toBe(0);
    expect(await ctx.db.runStep.count({ where: { runId: ana.run.id } })).toBe(0);
    expect(await ctx.db.task.count({ where: { id: ana.task.id } })).toBe(0);
    expect(await ctx.db.event.count({ where: { subject: `conversation:${ana.conv.id}` } })).toBe(0);
    expect(await ctx.db.task.findUniqueOrThrow({ where: { id: appTask.id } })).toMatchObject({ contactId: null });
    const note = await ctx.db.memory.findFirstOrThrow({ where: { workspaceId: ws, contactId: null } });
    expect(note.content).not.toMatch(/Ana Pérez|34600111222/);
    expect(note.content).toContain("Luis Gómez");
    // Luis sigue intacto.
    expect(await ctx.db.message.count({ where: { conversationId: luis.conv.id } })).toBe(2);
    const log = await ctx.db.auditLog.findFirstOrThrow({ where: { workspaceId: ws, action: "privacy.contact_erased" } });
    expect(JSON.stringify(log.data)).not.toContain("Ana");
  });

  it("solo con privacy:admin y sin cruzar workspaces", async () => {
    const w = await seedWorkspace(ctx, `p2-${Date.now()}`);
    const op = await seedWorkspace(ctx, `p3-${Date.now()}`, ["contacts:read", "contacts:write"]);
    const other = await seedWorkspace(ctx, `p4-${Date.now()}`);
    const p = await seedPerson(w.workspace.id, "Marta Ruiz", "34600555666");
    expect((await app.inject({ method: "GET", url: `/v1/contacts/${p.contact.id}/export`, headers: op.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/v1/contacts/${p.contact.id}/export`, headers: other.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/contacts/${p.contact.id}/erase`, headers: other.auth, payload: { confirm: true } })).statusCode).toBe(
      404,
    );
    expect(await ctx.db.contact.count({ where: { id: p.contact.id } })).toBe(1);
  });
});

describe("Retención", () => {
  it("el tenant la baja (máx. 365) y el barrido purga lo vencido de cada workspace según la suya", async () => {
    const short = await seedWorkspace(ctx, `r1-${Date.now()}`);
    const normal = await seedWorkspace(ctx, `r2-${Date.now()}`);
    expect((await app.inject({ method: "PUT", url: "/v1/workspace/retention", headers: short.auth, payload: { contentDays: 400 } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: "/v1/workspace/retention", headers: short.auth, payload: { contentDays: 30, auditDays: 60 } })).json(),
    ).toEqual({ contentDays: 30, auditDays: 60 });

    const old = new Date(Date.now() - 100 * 86_400_000);
    const recent = new Date(Date.now() - 5 * 86_400_000);
    for (const w of [short, normal]) {
      const p = await seedPerson(w.workspace.id, `Persona ${w.workspace.slug}`, `3460${Math.floor(Math.random() * 1e7)}`);
      await ctx.db.message.updateMany({ where: { conversationId: p.conv.id, direction: "INBOUND" }, data: { createdAt: old } });
      await ctx.db.message.updateMany({ where: { conversationId: p.conv.id, direction: "OUTBOUND" }, data: { createdAt: recent } });
      await ctx.db.task.update({ where: { id: p.task.id }, data: { status: "SUCCEEDED", finishedAt: old } });
      await ctx.db.run.update({ where: { id: p.run.id }, data: { finishedAt: old } });
      await ctx.db.auditLog.create({ data: { workspaceId: w.workspace.id, actorType: "system", action: "old", createdAt: old } });
    }
    const r = await ctx.privacy.retentionSweep();
    expect(r.workspaces).toBeGreaterThanOrEqual(2);
    expect(await ctx.db.message.count({ where: { workspaceId: short.workspace.id } })).toBe(1); // solo el reciente
    expect(await ctx.db.task.count({ where: { workspaceId: short.workspace.id } })).toBe(0);
    expect(await ctx.db.auditLog.count({ where: { workspaceId: short.workspace.id, action: "old" } })).toBe(0);
    expect(await ctx.db.message.count({ where: { workspaceId: normal.workspace.id } })).toBe(2); // 365 días por defecto
    expect(await ctx.db.task.count({ where: { workspaceId: normal.workspace.id } })).toBe(1);
    const policies = await app.inject({ method: "GET", url: "/v1/workspace/policies", headers: normal.auth });
    expect(policies.json().retention).toEqual({ contentDays: 365, auditDays: 365 });
  });
});
