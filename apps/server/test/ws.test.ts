import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { resetDb, seedAgent, seedWorkspace, testContext } from "./helpers.js";

let ctx: AppContext;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  ctx = testContext();
  await resetDb(ctx);
  await ctx.bus.start();
  app = await buildApp(ctx);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await app.close();
  await closeContext(ctx);
});

async function ticket(auth: Record<string, string>): Promise<string> {
  const res = await fetch(`http://${base}/v1/ws/tickets`, { method: "POST", headers: auth });
  expect(res.status).toBe(201);
  return (await res.json()).ticket;
}

function open(t: string): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/v1/ws?ticket=${encodeURIComponent(t)}`);
    const inbox: Array<Record<string, unknown>> = [];
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    };
    ws.onopen = () => resolve({ ws, next: () => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise((r) => waiters.push(r))) });
    ws.onerror = () => reject(new Error("ws error"));
  });
}

describe("WebSocket con tickets", () => {
  it("ticket de un solo uso; backlog + eventos en vivo del run; aislamiento por workspace", async () => {
    const w = await seedWorkspace(ctx, "ws-a");
    const other = await seedWorkspace(ctx, "ws-b");
    const agent = await seedAgent(ctx, w.workspace.id);
    const run = await ctx.db.run.create({ data: { workspaceId: w.workspace.id, agentId: agent.id, agentVersion: 1, trigger: "test" } });
    const otherAgent = await seedAgent(ctx, other.workspace.id);
    const foreignRun = await ctx.db.run.create({ data: { workspaceId: other.workspace.id, agentId: otherAgent.id, agentVersion: 1, trigger: "test" } });
    await ctx.bus.publish({ workspaceId: w.workspace.id, type: "run.started", subject: `run:${run.id}`, data: {} });

    const t = await ticket(w.auth);
    const { ws, next } = await open(t);
    ws.send(JSON.stringify({ type: "subscribe", subject: `run:${run.id}` }));
    expect(await next()).toEqual({ type: "subscribed", subject: `run:${run.id}` });
    expect(await next()).toMatchObject({ type: "event", event: "run.started" }); // backlog

    await ctx.bus.publish({ workspaceId: w.workspace.id, type: "message.delta", subject: `run:${run.id}`, data: { delta: "Hola" } });
    expect(await next()).toMatchObject({ type: "event", event: "message.delta", data: { delta: "Hola" } }); // en vivo

    ws.send(JSON.stringify({ type: "subscribe", subject: `run:${foreignRun.id}` }));
    expect(await next()).toMatchObject({ type: "error", code: "not_found" });
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await next()).toEqual({ type: "pong" });
    ws.close();

    // El mismo ticket no sirve dos veces.
    await expect(open(t)).rejects.toThrow();
  });

  it("connection:<id> exige connections:read", async () => {
    const w = await seedWorkspace(ctx, "ws-c", ["events:read"]);
    const conn = await ctx.db.connection.create({ data: { workspaceId: w.workspace.id, kind: "channel.whatsapp_baileys", name: "wa" } });
    const { ws, next } = await open(await ticket(w.auth));
    ws.send(JSON.stringify({ type: "subscribe", subject: `connection:${conn.id}` }));
    expect(await next()).toMatchObject({ type: "error", code: "forbidden" });
    ws.close();
  });
});

describe("bus de eventos", () => {
  it("entrega los eventos en orden de seq aunque lleguen en ráfaga", async () => {
    const w = await seedWorkspace(ctx, "bus-order");
    const received: string[] = [];
    const off = ctx.bus.subscribe(w.workspace.id, "run:orden", (e) => received.push(e.seq));
    const published: string[] = [];
    for (let i = 0; i < 40; i++) published.push((await ctx.bus.publish({ workspaceId: w.workspace.id, type: "t", subject: "run:orden", data: { i } })).seq);
    const deadline = Date.now() + 5000;
    while (received.length < published.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    off();
    expect(received).toEqual(published);
  });
});
