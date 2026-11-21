import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WAMessage } from "baileys";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { systemActor } from "../src/data/audit.js";
import type { BusEvent } from "../src/execution/events/bus.js";
import { BaileysSessionManager, normalizeBaileysMessage, type BaileysSocketLike } from "../src/integrations/channels/whatsapp-baileys.js";
import { RecordingQueue, resetDb, seedAgent, seedWorkspace, testContext, waitFor } from "./helpers.js";

/**
 * Regresiones de la revisión de código (bloque de estabilidad): C1, H6, M2, M11, L1, L2, L9.
 */
let ctx: AppContext;
let app: FastifyInstance;
let base: string;
const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);

beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  ctx = testContext();
  await resetDb(ctx);
  await ctx.bus.start();
  app = await buildApp(ctx);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
  await app.close();
  await closeContext(ctx);
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

async function openWs(auth: Record<string, string>) {
  const res = await fetch(`http://${base}/v1/ws/tickets`, { method: "POST", headers: auth });
  const { ticket } = (await res.json()) as { ticket: string };
  return new Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
    const inbox: Array<Record<string, unknown>> = [];
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    };
    ws.onopen = () => resolve({ ws, next: () => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise((r) => waiters.push(r))) });
    ws.onerror = () => reject(new Error("ws error"));
  });
}

describe("C1 · WebSocket no tumba el proceso", () => {
  it("rechaza subjects que no son UUID (36 guiones) sin llegar a Postgres", async () => {
    const w = await seedWorkspace(ctx, "c1-a");
    const { ws, next } = await openWs(w.auth);
    for (const subject of [`run:${"-".repeat(36)}`, `conversation:${"a".repeat(36)}`, "run:00000000-0000-0000-0000-00000000000g"]) {
      ws.send(JSON.stringify({ type: "subscribe", subject }));
      expect(await next()).toMatchObject({ type: "error", code: "bad_subject" });
    }
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await next()).toEqual({ type: "pong" });
    ws.close();
    expect((await fetch(`http://${base}/health`)).status).toBe(200);
  });

  it("un fallo de base de datos durante subscribe responde internal_error y el socket sigue vivo", async () => {
    const w = await seedWorkspace(ctx, "c1-b");
    const agent = await seedAgent(ctx, w.workspace.id);
    const run = await ctx.db.run.create({ data: { workspaceId: w.workspace.id, agentId: agent.id, agentVersion: 1, trigger: "test" } });
    vi.spyOn(ctx.bus, "follow").mockRejectedValueOnce(new Error("conexión perdida"));

    const { ws, next } = await openWs(w.auth);
    ws.send(JSON.stringify({ type: "subscribe", subject: `run:${run.id}` }));
    expect(await next()).toEqual({ type: "subscribed", subject: `run:${run.id}` });
    expect(await next()).toMatchObject({ type: "error", code: "internal_error", subject: `run:${run.id}` });

    // Tras el fallo se puede volver a suscribir (no quedó una suscripción fantasma).
    ws.send(JSON.stringify({ type: "subscribe", subject: `RUN:${run.id.toUpperCase()}` }));
    expect(await next()).toEqual({ type: "subscribed", subject: `run:${run.id}` }); // normalizado
    await ctx.bus.publish({ workspaceId: w.workspace.id, type: "tick", subject: `run:${run.id}` });
    expect(await next()).toMatchObject({ type: "event", event: "tick" });
    ws.close();
    expect((await fetch(`http://${base}/health`)).status).toBe(200);
  });

  it("SSE: un fallo del bus cierra el stream con un evento error, sin rechazo sin capturar", async () => {
    const w = await seedWorkspace(ctx, "c1-c");
    const agent = await seedAgent(ctx, w.workspace.id);
    const run = await ctx.db.run.create({ data: { workspaceId: w.workspace.id, agentId: agent.id, agentVersion: 1, trigger: "test" } });
    vi.spyOn(ctx.bus, "follow").mockRejectedValueOnce(new Error("conexión perdida"));
    const res = await fetch(`http://${base}/v1/runs/${run.id}/events`, { headers: w.auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: error");
  });
});

describe("L1/L2 · rutas", () => {
  it("webhook con connectionId no UUID → 404/403 sin error 500", async () => {
    const bad = "-".repeat(36);
    expect(
      (await fetch(`http://${base}/webhooks/whatsapp/${bad}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(404);
    expect((await fetch(`http://${base}/webhooks/whatsapp/${bad}?hub.mode=subscribe`)).status).toBe(403);
  });

  it("ruta inexistente → 404 con el formato estándar", async () => {
    const res = await fetch(`http://${base}/v1/no-existe`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Ruta no encontrada" } });
  });
});

describe("M11 · orden por subject con publicaciones concurrentes", () => {
  it("todas las publicaciones concurrentes llegan, en orden de seq y sin huecos", async () => {
    const w = await seedWorkspace(ctx, "m11");
    const subject = "run:11111111-1111-4111-8111-111111111111";
    const got: BusEvent[] = [];
    const off = ctx.bus.subscribe(w.workspace.id, subject, (e) => got.push(e));
    await Promise.all(Array.from({ length: 40 }, (_, i) => ctx.bus.publish({ workspaceId: w.workspace.id, type: "tick", subject, data: { i } })));
    await waitFor(async () => got.length === 40, 10_000);
    off();
    const seqs = got.map((e) => BigInt(e.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : 1)));
  });
});

describe("H6 · el bus se recupera si se corta la conexión LISTEN", () => {
  it("reconecta, reproduce lo publicado durante el corte y /ready lo refleja", async () => {
    const w = await seedWorkspace(ctx, "h6");
    const subject = "conversation:22222222-2222-4222-8222-222222222222";
    const got: string[] = [];
    const off = await ctx.bus.follow(w.workspace.id, subject, 0n, (e) => got.push(e.type));
    await ctx.bus.publish({ workspaceId: w.workspace.id, type: "antes", subject });
    await waitFor(async () => got.includes("antes"));

    const pid = (ctx.bus as unknown as { client: { processID: number } }).client.processID;
    await ctx.db.$executeRaw`SELECT pg_terminate_backend(${pid}::int)`;
    await waitFor(async () => !ctx.bus.isHealthy(), 5_000, 20);
    const notReady = await fetch(`http://${base}/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({ status: "not_ready", bus: false, db: true });

    await ctx.bus.publish({ workspaceId: w.workspace.id, type: "durante", subject }); // NOTIFY perdido
    await waitFor(async () => ctx.bus.isHealthy(), 10_000);
    await waitFor(async () => got.includes("durante"), 5_000);
    await ctx.bus.publish({ workspaceId: w.workspace.id, type: "despues", subject });
    await waitFor(async () => got.includes("despues"), 5_000);
    off();
    expect(got).toEqual(["antes", "durante", "despues"]);
    expect((await fetch(`http://${base}/ready`)).status).toBe(200);
  });
});

describe("M2/L9 · Baileys", () => {
  const msg = (key: Record<string, unknown>): WAMessage => ({ key: { fromMe: false, id: "M1", ...key }, message: { conversation: "Hola" } }) as WAMessage;

  it("LID: no se inventa un teléfono; usa remoteJidAlt si viene", () => {
    expect(normalizeBaileysMessage(msg({ remoteJid: "123456789012345@lid" }))).toMatchObject({ phone: null, contactId: "lid:123456789012345" });
    expect(normalizeBaileysMessage(msg({ remoteJid: "123456789012345@lid", remoteJidAlt: "34600111222@s.whatsapp.net" }))).toMatchObject({
      phone: "34600111222",
      contactId: "34600111222",
    });
  });

  it("un listener que falla no produce rechazos sin capturar y el backoff crece entre cierres", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ega-m2-"));
    const queue = new RecordingQueue();
    const w = await seedWorkspace(ctx, "m2");
    const agent = await seedAgent(ctx, w.workspace.id);
    const conn = await ctx.connections.create(w.workspace.id, { kind: "channel.whatsapp_baileys", name: "wa", config: { agentId: agent.id } }, systemActor);
    const emitters: EventEmitter[] = [];
    const manager = new BaileysSessionManager({
      db: ctx.db,
      bus: ctx.bus,
      queue,
      log: ctx.log,
      dataDir,
      factory: async () => {
        const ev = new EventEmitter();
        emitters.push(ev);
        const socket: BaileysSocketLike = { ev, sendMessage: async () => undefined, end: () => undefined, logout: async () => undefined };
        return { socket, saveCreds: async () => Promise.reject(new Error("disco lleno")) };
      },
    });
    await manager.start(conn.id);
    emitters[0]!.emit("creds.update", {}); // saveCreds rechaza → capturado
    vi.spyOn(ctx.bus, "publish").mockRejectedValueOnce(new Error("bus caído"));
    emitters[0]!.emit("connection.update", { qr: "2@QR" }); // publish rechaza → capturado

    emitters[0]!.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
    expect(manager.retryCount(conn.id)).toBe(1);
    await waitFor(async () => emitters.length === 2, 5_000, 50); // reintento tras 1 s
    emitters[1]!.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
    expect(manager.retryCount(conn.id)).toBe(2); // antes volvía a 0 en cada cierre
    await manager.stop(conn.id);
    expect(manager.retryCount(conn.id)).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    await rm(dataDir, { recursive: true, force: true });
  });
});
