import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createUserWithPassword } from "../src/access/auth/better-auth.js";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { RecordingQueue, resetDb, seedAgent, seedWorkspace, testContext } from "./helpers.js";

let ctx: AppContext;
let app: FastifyInstance;
let queue: RecordingQueue;

beforeAll(async () => {
  queue = new RecordingQueue();
  ctx = testContext({ queue });
  app = await buildApp(ctx);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeContext(ctx);
});
beforeEach(async () => {
  await resetDb(ctx);
  queue.jobs.length = 0;
});

describe("auth y scopes", () => {
  it("sin credenciales → 401; key sin scope → 403; key revocada → 401", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/agents" })).statusCode).toBe(401);

    const ro = await seedWorkspace(ctx, "ro", ["chats:read"]);
    const forbidden = await app.inject({ method: "GET", url: "/v1/agents", headers: ro.auth });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");

    const full = await seedWorkspace(ctx, "full");
    expect((await app.inject({ method: "GET", url: "/v1/agents", headers: full.auth })).statusCode).toBe(200);
    await ctx.db.apiKey.updateMany({ where: { workspaceId: full.workspace.id }, data: { revokedAt: new Date() } });
    expect((await app.inject({ method: "GET", url: "/v1/agents", headers: full.auth })).statusCode).toBe(401);
  });

  it("no se puede emitir una key con más scopes que los propios", async () => {
    const limited = await seedWorkspace(ctx, "lim", ["api_keys:write", "agents:read"]);
    const res = await app.inject({ method: "POST", url: "/v1/api-keys", headers: limited.auth, payload: { name: "x", scopes: ["agents:write"] } });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/v1/api-keys", headers: limited.auth, payload: { name: "x", scopes: ["agents:read"] } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().token).toMatch(/^ega_/);
  });
});

describe("aislamiento por workspace", () => {
  it("un workspace no ve ni toca recursos de otro", async () => {
    const a = await seedWorkspace(ctx, "a");
    const b = await seedWorkspace(ctx, "b");
    const agentB = await seedAgent(ctx, b.workspace.id);
    const chatB = await ctx.db.conversation.create({ data: { workspaceId: b.workspace.id, agentId: agentB.id, channel: "api" } });

    expect((await app.inject({ method: "GET", url: `/v1/agents/${agentB.id}`, headers: a.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/v1/agents/${agentB.id}`, headers: a.auth, payload: { name: "hack" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/chats", headers: a.auth, payload: { agentId: agentB.id } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/chats/${chatB.id}/messages`, headers: a.auth, payload: { text: "hola" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/chats/${chatB.id}/messages`, headers: a.auth })).statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/v1/agents", headers: a.auth });
    expect(list.json().data).toEqual([]);
    expect(queue.jobs).toHaveLength(0);
  });
});

describe("agentes", () => {
  it("crea, valida tools y versiona al cambiar comportamiento", async () => {
    const w = await seedWorkspace(ctx, "ag");
    const bad = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: w.auth,
      payload: { name: "X", instructions: "i", model: "openai:gpt", tools: ["no.existe"] },
    });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: w.auth,
      payload: { name: "X", instructions: "i", model: "openai:gpt", tools: ["memory.save"] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const renamed = await app.inject({ method: "PATCH", url: `/v1/agents/${id}`, headers: w.auth, payload: { name: "Y" } });
    expect(renamed.json().version).toBe(1);
    const changed = await app.inject({ method: "PATCH", url: `/v1/agents/${id}`, headers: w.auth, payload: { instructions: "nuevas" } });
    expect(changed.json().version).toBe(2);
    expect(await ctx.db.auditLog.count({ where: { workspaceId: w.workspace.id } })).toBe(3);
  });
});

describe("Idempotency-Key", () => {
  it("repite la respuesta sin duplicar el efecto; otro cuerpo con la misma clave → 422", async () => {
    const w = await seedWorkspace(ctx, "idem");
    const agent = await seedAgent(ctx, w.workspace.id);
    const chat = (await app.inject({ method: "POST", url: "/v1/chats", headers: w.auth, payload: { agentId: agent.id } })).json();
    const headers = { ...w.auth, "idempotency-key": "k-123" };

    const first = await app.inject({ method: "POST", url: `/v1/chats/${chat.id}/messages`, headers, payload: { text: "hola" } });
    const second = await app.inject({ method: "POST", url: `/v1/chats/${chat.id}/messages`, headers, payload: { text: "hola" } });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
    expect(await ctx.db.message.count({ where: { conversationId: chat.id } })).toBe(1);
    expect(queue.jobs.filter((j) => j.name === "run.process")).toHaveLength(1);

    const reused = await app.inject({ method: "POST", url: `/v1/chats/${chat.id}/messages`, headers, payload: { text: "otra cosa" } });
    expect(reused.statusCode).toBe(422);
  });
});

describe("contrato", () => {
  it("expone OpenAPI 3.1 con las rutas v1", async () => {
    const spec = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/v1/agents", "/v1/chats/{id}/messages", "/v1/runs/{id}/events", "/v1/approvals/{id}/approve"]),
    );
  });
  it("health y ready", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    expect((await app.inject({ method: "GET", url: "/ready" })).json()).toEqual({ status: "ready", db: true, bus: true, queue: true });
  });
});

describe("sesión de usuario (Better Auth) + X-Workspace-Id", () => {
  it("alta y login; acceso solo a workspaces donde es miembro, con scopes por rol", async () => {
    const w = await seedWorkspace(ctx, "ses");
    const other = await seedWorkspace(ctx, "otro");
    const origin = { origin: ctx.env.PUBLIC_URL };
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: origin,
      payload: { email: "op@example.com", password: "clave-segura-123", name: "Operador" },
    });
    expect(signUp.statusCode).toBeGreaterThanOrEqual(400); // M3: alta pública cerrada por defecto
    expect(await ctx.db.user.count({ where: { email: "op@example.com" } })).toBe(0);
    await createUserWithPassword(ctx.db, {
      email: "op@example.com",
      name: "Operador",
      password: "clave-segura-123",
      workspaceId: w.workspace.id,
      role: "OPERATOR",
    });
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: origin,
      payload: { email: "op@example.com", password: "clave-segura-123" },
    });
    expect(signIn.statusCode).toBe(200);
    const raw = signIn.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");

    const asMember = await app.inject({ method: "GET", url: "/v1/agents", headers: { cookie, "x-workspace-id": w.workspace.id } });
    expect(asMember.statusCode).toBe(200);
    // OPERATOR no puede crear agentes
    const write = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie, "x-workspace-id": w.workspace.id },
      payload: { name: "X", instructions: "i", model: "a:b" },
    });
    expect(write.statusCode).toBe(403);
    // M5: un OPERATOR no aprueba acciones
    const approve = await app.inject({
      method: "POST",
      url: "/v1/approvals/00000000-0000-4000-8000-000000000000/approve",
      headers: { cookie, "x-workspace-id": w.workspace.id },
      payload: {},
    });
    expect(approve.statusCode).toBe(403);
    // /v1/me con rol, scopes y membresías
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie, "x-workspace-id": w.workspace.id } });
    expect(me.json()).toMatchObject({
      kind: "user",
      role: "OPERATOR",
      user: { email: "op@example.com" },
      memberships: [{ workspaceId: w.workspace.id, role: "OPERATOR" }],
    });
    expect(me.json().scopes).not.toContain("approvals:write");
    // Workspace donde no es miembro
    const foreign = await app.inject({ method: "GET", url: "/v1/agents", headers: { cookie, "x-workspace-id": other.workspace.id } });
    expect(foreign.statusCode).toBe(401);
  });
});
