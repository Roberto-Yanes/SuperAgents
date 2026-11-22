import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { TEMPLATES } from "../src/domain/templates/catalog.js";
import { RecordingQueue, resetDb, seedWorkspace, testContext } from "./helpers.js";

/** Plantillas por rubro: catálogo y aplicación. */
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

describe("Plantillas por rubro", () => {
  it("todas se aplican sin errores: agente con tools válidas, embudo, calendario, secuencia y rutinas desactivadas", async () => {
    const list = (await app.inject({ method: "GET", url: "/v1/templates", headers: (await seedWorkspace(ctx, `tl-${Date.now()}`)).auth })).json().data;
    expect(list.map((t: { id: string }) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
    for (const t of TEMPLATES) {
      const w = await seedWorkspace(ctx, `t-${t.id}-${Date.now()}`);
      const res = await app.inject({
        method: "POST",
        url: `/v1/templates/${t.id}/apply`,
        headers: w.auth,
        payload: { model: "mistral:mistral-medium-latest" },
      });
      expect(res.statusCode, `${t.id}: ${res.body}`).toBe(201);
      const out = res.json();
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: out.agentId } });
      expect((agent.toolConfig as { tools: string[] }).tools).toEqual(t.agent.tools);
      expect(out.pipelineApplied).toBe(true);
      expect((await ctx.leads.stages(w.workspace.id)).map((s) => s.name)).toEqual(t.pipeline.map((s) => s.name));
      expect(Boolean(out.calendarId)).toBe(Boolean(t.calendar));
      expect(Boolean(out.sequenceId)).toBe(Boolean(t.sequence));
      const routines = await ctx.db.routine.findMany({ where: { workspaceId: w.workspace.id } });
      expect(routines).toHaveLength(t.routines.length);
      expect(routines.every((r) => !r.enabled)).toBe(true);
      expect(out.checklist.length).toBeGreaterThan(0);
    }
  });

  it("no pisa un embudo con leads, y una plantilla inexistente da 404", async () => {
    const w = await seedWorkspace(ctx, `tp-${Date.now()}`);
    const stages = await ctx.leads.stages(w.workspace.id);
    const contact = await ctx.db.contact.create({ data: { workspaceId: w.workspace.id, name: "Ana" } });
    await ctx.db.lead.create({ data: { workspaceId: w.workspace.id, contactId: contact.id, title: "Lead", stageId: stages[0]!.id } });
    const res = await app.inject({ method: "POST", url: "/v1/templates/restaurante/apply", headers: w.auth, payload: { model: "mistral:x" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ pipelineApplied: false });
    expect(res.json().warnings[0]).toContain("embudo");
    expect((await app.inject({ method: "POST", url: "/v1/templates/no-existe/apply", headers: w.auth, payload: { model: "mistral:x" } })).statusCode).toBe(404);
  });

  it("aplicar exige templates:apply y agents:write", async () => {
    const w = await seedWorkspace(ctx, `tsc-${Date.now()}`, ["agents:read"]);
    expect((await app.inject({ method: "POST", url: "/v1/templates/gestoria/apply", headers: w.auth, payload: { model: "mistral:x" } })).statusCode).toBe(403);
  });
});
