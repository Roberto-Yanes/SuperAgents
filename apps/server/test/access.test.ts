import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { createUserWithPassword } from "../src/access/auth/better-auth.js";
import { buildApp } from "../src/access/http/app.js";
import { loadEnv } from "../src/shared/config/env.js";
import { closeContext, type AppContext } from "../src/container.js";
import { hasWorkspaceFilter, TenantGuardError, withTenantGuard } from "../src/data/tenant-guard.js";
import { builtinTools } from "../src/integrations/tools/builtin/index.js";
import { ToolRegistry } from "../src/integrations/tools/registry.js";
import { defineTool, type ToolDef } from "../src/integrations/tools/types.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { RecordingQueue, resetDb, scriptedModel, seedAgent, seedWorkspace, testContext } from "./helpers.js";

/** Regresiones de la revisión (bloque de acceso): M3, M4, M5, M6, M7 y rutas nuevas. */
let ctx: AppContext;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.CORS_ORIGINS = "https://app.example.com";
  ctx = testContext({ queue: new RecordingQueue() });
  delete process.env.CORS_ORIGINS;
  await resetDb(ctx);
  app = await buildApp(ctx);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeContext(ctx);
});

async function runIn(w: Awaited<ReturnType<typeof seedWorkspace>>, status: "QUEUED" | "WAITING_APPROVAL" | "SUCCEEDED" = "QUEUED") {
  const agent = await seedAgent(ctx, w.workspace.id);
  return ctx.db.run.create({ data: { workspaceId: w.workspace.id, agentId: agent.id, agentVersion: 1, trigger: "test", status } });
}

describe("M3 · alta de usuarios", () => {
  it("createUserWithPassword reutiliza el usuario y actualiza su rol; exige 12 caracteres", async () => {
    const w = await seedWorkspace(ctx, "m3");
    const a = await createUserWithPassword(ctx.db, {
      email: "Ana@X.com",
      name: "Ana",
      password: "una-clave-larga",
      workspaceId: w.workspace.id,
      role: "OPERATOR",
    });
    const b = await createUserWithPassword(ctx.db, {
      email: "ana@x.com",
      name: "Ana",
      password: "otra-clave-larga",
      workspaceId: w.workspace.id,
      role: "ADMIN",
    });
    expect(a).toMatchObject({ created: true });
    expect(b).toEqual({ userId: a.userId, created: false });
    expect((await ctx.db.membership.findFirstOrThrow({ where: { userId: a.userId } })).role).toBe("ADMIN");
    await expect(
      createUserWithPassword(ctx.db, { email: "x@x.com", name: "X", password: "corta", workspaceId: w.workspace.id, role: "ADMIN" }),
    ).rejects.toThrow(/12/);
  });
});

describe("M4 · Idempotency-Key global", () => {
  it("se aplica a cualquier POST: misma clave → misma respuesta sin repetir el efecto", async () => {
    const w = await seedWorkspace(ctx, "m4a");
    const agent = await seedAgent(ctx, w.workspace.id);
    const req = { method: "POST" as const, url: "/v1/chats", headers: { ...w.auth, "idempotency-key": "k-1" }, payload: { agentId: agent.id } };
    const first = await app.inject(req);
    const second = await app.inject(req);
    expect(first.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json().id).toBe(first.json().id);
    expect(await ctx.db.conversation.count({ where: { workspaceId: w.workspace.id } })).toBe(1);
  });

  it("una petición en curso bloquea (409) solo hasta que vence su plazo; luego la clave se libera", async () => {
    const w = await seedWorkspace(ctx, "m4b");
    const agent = await seedAgent(ctx, w.workspace.id);
    const payload = { agentId: agent.id };
    const base = { workspaceId: w.workspace.id, method: "POST", path: "/v1/chats", expiresAt: new Date(Date.now() + 3600_000) };
    const { canonicalJson, sha256Hex } = await import("../src/shared/security/crypto.js");
    const requestHash = sha256Hex(`POST /v1/chats ${canonicalJson(payload)}`);
    await ctx.db.idempotencyRecord.create({ data: { ...base, key: "busy", requestHash, lockedUntil: new Date(Date.now() + 60_000) } });
    await ctx.db.idempotencyRecord.create({ data: { ...base, key: "stale", requestHash, lockedUntil: new Date(Date.now() - 1_000) } });
    const send = (key: string) => app.inject({ method: "POST", url: "/v1/chats", headers: { ...w.auth, "idempotency-key": key }, payload });
    expect((await send("busy")).statusCode).toBe(409);
    expect((await send("stale")).statusCode).toBe(201); // abandonada tras una caída: ya no bloquea 24 h
  });

  it("401/403 no consumen la clave", async () => {
    const w = await seedWorkspace(ctx, "m4c", ["chats:read"]);
    const r = await app.inject({
      method: "POST",
      url: "/v1/chats",
      headers: { ...w.auth, "idempotency-key": "k-403" },
      payload: { agentId: crypto.randomUUID() },
    });
    expect(r.statusCode).toBe(403);
    expect(await ctx.db.idempotencyRecord.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
  });
});

describe("Runs: listado y cancelación", () => {
  it("lista con filtros y cursor; cancela QUEUED y WAITING_APPROVAL (rechaza sus aprobaciones); cuerpo JSON vacío permitido", async () => {
    const w = await seedWorkspace(ctx, "runs");
    const queued = await runIn(w);
    const waiting = await runIn(w, "WAITING_APPROVAL");
    const done = await runIn(w, "SUCCEEDED");
    await ctx.db.approval.create({
      data: {
        workspaceId: w.workspace.id,
        runId: waiting.id,
        toolName: "x",
        toolCallId: "c",
        args: {},
        preview: "x",
        mode: "ASK_OWNER",
        idempotencyKey: `k-${waiting.id}`,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const list = await app.inject({ method: "GET", url: "/v1/runs?limit=2", headers: w.auth });
    expect(list.json().data.map((r: { id: string }) => r.id)).toEqual([done.id, waiting.id]);
    const page2 = await app.inject({ method: "GET", url: `/v1/runs?limit=2&cursor=${list.json().nextCursor}`, headers: w.auth });
    expect(page2.json()).toMatchObject({ data: [{ id: queued.id }], nextCursor: null });
    expect((await app.inject({ method: "GET", url: "/v1/runs?status=SUCCEEDED", headers: w.auth })).json().data).toHaveLength(1);

    const cancel = (id: string) =>
      app.inject({ method: "POST", url: `/v1/runs/${id}/cancel`, headers: { ...w.auth, "content-type": "application/json" }, payload: "" });
    expect((await cancel(queued.id)).statusCode).toBe(204);
    expect((await cancel(waiting.id)).statusCode).toBe(204);
    expect((await cancel(done.id)).statusCode).toBe(409);
    expect((await ctx.db.approval.findFirstOrThrow({ where: { runId: waiting.id } })).status).toBe("REJECTED");
    expect(await ctx.db.event.findFirst({ where: { subject: `run:${queued.id}`, type: "run.finished" } })).toMatchObject({ data: { status: "CANCELLED" } });
  });

  it("cancelar un run en curso: se aborta tras el paso y no entrega respuesta", async () => {
    const holder: { ctx?: AppContext } = {};
    const cancelling = defineTool({
      name: "test.slow",
      description: "Tarda",
      input: z.object({}),
      scope: "x",
      risk: "read",
      approval: "NEVER",
      async execute(_i, tctx) {
        await holder.ctx!.runControl.cancel(tctx.workspaceId, tctx.runId, { type: "user", id: "u1" }); // una persona cancela a mitad
        return { ok: true };
      },
    });
    const tools = new ToolRegistry();
    for (const t of [...builtinTools, cancelling as ToolDef]) tools.register(t);
    const scripted = scriptedModel([{ toolCalls: [{ id: "c1", name: "test__slow", input: {} }] }, { text: "Esto no debería enviarse" }]);
    const local = (holder.ctx = testContext({ tools, queue: new RecordingQueue(), llm: new StaticLlmResolver(scripted.model) }));
    try {
      const ws = await local.db.workspace.create({ data: { name: "c", slug: "cancel-live" } });
      const agent = await seedAgent(local, ws.id, ["test.slow"]);
      const conv = await local.conversations.createApiChat(ws.id, agent.id);
      const r = await local.conversations.receive({ workspaceId: ws.id, conversationId: conv.id, text: "hola", author: "HUMAN", trigger: "api.chat" });
      if (r.status !== "run_queued") throw new Error("sin run");
      await local.runtime.execute(ws.id, r.runId);
      expect((await local.db.run.findUniqueOrThrow({ where: { id: r.runId } })).status).toBe("CANCELLED");
      expect(scripted.calls()).toBe(1); // no hubo segundo paso del modelo
      expect(await local.db.message.count({ where: { runId: r.runId, direction: "OUTBOUND" } })).toBe(0);
    } finally {
      await closeContext(local);
    }
  });
});

describe("M5/M6 y rutas de contexto", () => {
  it("OPERATOR no tiene approvals:write", async () => {
    const { scopesForRole } = await import("../src/access/auth/scopes.js");
    expect(scopesForRole("OPERATOR").has("approvals:write")).toBe(false);
    expect(scopesForRole("ADMIN").has("approvals:write")).toBe(true);
  });

  it("SSE con ?ticket= de un solo uso y cabeceras CORS", async () => {
    const w = await seedWorkspace(ctx, "sse");
    const run = await runIn(w, "SUCCEEDED");
    await ctx.bus.publish({ workspaceId: w.workspace.id, type: "run.finished", subject: `run:${run.id}`, data: { status: "SUCCEEDED" } });
    const t = (await app.inject({ method: "POST", url: "/v1/ws/tickets", headers: w.auth })).json().ticket as string;
    const res = await app.inject({ method: "GET", url: `/v1/runs/${run.id}/events?ticket=${t}`, headers: { origin: "https://app.example.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(res.body).toContain("event: run.finished");
    expect((await app.inject({ method: "GET", url: `/v1/runs/${run.id}/events?ticket=${t}` })).statusCode).toBe(401);
  });

  it("/v1/me con API key, /v1/tools con la cara de cada tool y /v1/events paginado", async () => {
    const w = await seedWorkspace(ctx, "ctx");
    const other = await seedWorkspace(ctx, "ctx-otro");
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: w.auth });
    expect(me.json()).toMatchObject({ kind: "api_key", workspace: { id: w.workspace.id, slug: "ctx" }, user: null, memberships: [] });

    const tools = (await app.inject({ method: "GET", url: "/v1/tools", headers: w.auth })).json().data as Array<{ name: string; exposure: string }>;
    expect(tools.find((t) => t.name === "handoff.request")).toMatchObject({ exposure: "external" });

    const run = await runIn(w);
    for (const type of ["a", "b", "c"]) await ctx.bus.publish({ workspaceId: w.workspace.id, type, subject: `run:${run.id}` });
    const p1 = (await app.inject({ method: "GET", url: `/v1/events?subject=run:${run.id}&limit=2`, headers: w.auth })).json();
    expect(p1.data.map((e: { type: string }) => e.type)).toEqual(["a", "b"]);
    const p2 = (await app.inject({ method: "GET", url: `/v1/events?subject=run:${run.id}&after=${p1.nextAfter}`, headers: w.auth })).json();
    expect(p2.data.map((e: { type: string }) => e.type)).toEqual(["c"]);
    expect((await app.inject({ method: "GET", url: `/v1/events?subject=run:${run.id}`, headers: other.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/events?subject=run:${"-".repeat(36)}`, headers: w.auth })).statusCode).toBe(400);
  });
});

describe("M7 · guarda multi-tenant", () => {
  it("detecta el filtro por workspace (directo, compuesto o en AND)", () => {
    expect(hasWorkspaceFilter({ workspaceId: "w" })).toBe(true);
    expect(hasWorkspaceFilter({ workspaceId_key: { workspaceId: "w", key: "k" } })).toBe(true);
    expect(hasWorkspaceFilter({ AND: [{ status: "x" }, { workspaceId: "w" }] })).toBe(true);
    expect(hasWorkspaceFilter({ id: "x" })).toBe(false);
    expect(hasWorkspaceFilter(undefined)).toBe(false);
  });

  it("el cliente con guarda rechaza consultas masivas sin workspaceId; el de sistema no", async () => {
    const guarded = withTenantGuard(ctx.db, "error");
    await expect(guarded.run.findMany({ where: { status: "QUEUED" } })).rejects.toBeInstanceOf(TenantGuardError);
    await expect(guarded.run.updateMany({ where: { id: crypto.randomUUID() }, data: { error: "x" } })).rejects.toBeInstanceOf(TenantGuardError);
    await expect(guarded.run.findMany({ where: { workspaceId: crypto.randomUUID() } })).resolves.toEqual([]);
    await expect(ctx.db.run.findMany({ where: { status: "QUEUED" }, take: 1 })).resolves.toBeDefined();
    expect(loadEnv({ ...process.env, NODE_ENV: "production" }).TENANT_GUARD).toBeUndefined(); // en prod: warn por defecto
  });
});
