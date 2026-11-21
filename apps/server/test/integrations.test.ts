import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { WAMessage } from "baileys";
import { closeContext, type AppContext } from "../src/container.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { BaileysSessionManager, normalizeBaileysMessage, type BaileysSocketLike } from "../src/integrations/channels/whatsapp-baileys.js";
import { defaultApproval, inferRisk, type ComposioClient } from "../src/integrations/composio/gateway.js";
import { systemActor } from "../src/data/audit.js";
import { RecordingQueue, resetDb, scriptedModel, seedAgent, testContext, waitFor } from "./helpers.js";

const contexts: AppContext[] = [];
afterAll(async () => {
  for (const c of contexts) await closeContext(c);
});

describe("Composio Gateway", () => {
  it("infiere riesgo y aprobación por el verbo del slug", () => {
    expect(inferRisk("GMAIL_SEND_EMAIL")).toBe("send");
    expect(inferRisk("GOOGLECALENDAR_CREATE_EVENT")).toBe("write");
    expect(inferRisk("HUBSPOT_LIST_CONTACTS")).toBe("read");
    expect(inferRisk("RARO_ALGO")).toBe("write");
    expect(defaultApproval("GMAIL_FETCH_EMAILS", "read")).toBe("NEVER");
    expect(defaultApproval("GMAIL_SEND_EMAIL", "send")).toBe("ASK_OWNER");
    expect(defaultApproval("GOOGLECALENDAR_DELETE_EVENT", "write")).toBe("ALWAYS");
  });

  it("las acciones habilitadas son tools del agente; las de envío piden aprobación y se ejecutan una vez", async () => {
    const executed: Array<{ slug: string; userId: string; args: unknown }> = [];
    const fakeClient = (): ComposioClient => ({
      async getTool(slug) {
        return {
          slug,
          toolkit: "gmail",
          description: `Acción ${slug}`,
          inputParameters: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] },
        };
      },
      async execute(slug, params) {
        executed.push({ slug, userId: params.userId, args: params.arguments });
        return { successful: true, data: { id: "msg-1" }, error: null };
      },
    });
    const queue = new RecordingQueue();
    const scripted = scriptedModel([
      { toolCalls: [{ id: "c1", name: "composio__gmail_send_email", input: { to: "ana@x.com", body: "Hola" } }] },
      { text: "Correo enviado." },
    ]);
    const ctx = testContext({ queue, composioClient: fakeClient, llm: new StaticLlmResolver(scripted.model) });
    contexts.push(ctx);
    await resetDb(ctx);
    const ws = await ctx.db.workspace.create({ data: { name: "cmp", slug: "cmp" } });
    await ctx.connections.create(
      ws.id,
      {
        kind: "composio",
        name: "composio",
        secret: { apiKey: "cmp-key-123456" },
        config: { tools: [{ slug: "GMAIL_SEND_EMAIL" }, { slug: "GMAIL_FETCH_EMAILS" }] },
      },
      systemActor,
    );

    const tools = await ctx.tools.resolveForAgent(ws.id, { tools: ["composio.gmail_send_email", "composio.gmail_fetch_emails"] });
    expect(tools.map((t) => [t.def.name, t.def.risk, t.mode])).toEqual([
      ["composio.gmail_send_email", "send", "ASK_OWNER"],
      ["composio.gmail_fetch_emails", "read", "NEVER"],
    ]);
    // Validación del agente: acepta acciones habilitadas, rechaza las que no lo están.
    await expect(
      ctx.agents.create(
        ws.id,
        { name: "a", instructions: "i", model: "x:y", tools: ["composio.gmail_delete_email"], approvals: {}, external: [], settings: {} },
        systemActor,
      ),
    ).rejects.toMatchObject({ code: "unknown_tools" });

    const agent = await seedAgent(ctx, ws.id, ["composio.gmail_send_email"]);
    const chat = await ctx.db.conversation.create({ data: { workspaceId: ws.id, agentId: agent.id, channel: "api" } });
    const r = await ctx.conversations.receive({ workspaceId: ws.id, conversationId: chat.id, text: "Escribe a Ana", author: "HUMAN", trigger: "test" });
    if (r.status !== "run_queued") throw new Error("run no encolado");
    await ctx.runtime.execute(ws.id, r.runId);
    expect(executed).toHaveLength(0);
    const approval = await ctx.db.approval.findFirstOrThrow({ where: { runId: r.runId } });
    expect(approval.toolName).toBe("composio.gmail_send_email");

    await ctx.approvals.decide(ws.id, approval.id, "APPROVED", systemActor);
    await ctx.runtime.resume(ws.id, r.runId);
    expect(executed).toEqual([{ slug: "GMAIL_SEND_EMAIL", userId: `ega:${ws.id}:integration`, args: { to: "ana@x.com", body: "Hola" } }]);
    expect((await ctx.db.run.findUniqueOrThrow({ where: { id: r.runId } })).status).toBe("SUCCEEDED");
  });
});

describe("WhatsApp por Baileys", () => {
  const msg = (over: Partial<WAMessage> & { text?: string }): WAMessage =>
    ({
      key: { remoteJid: "34600111222@s.whatsapp.net", fromMe: false, id: "BAE5.1", ...over.key },
      pushName: "Ana",
      message: { conversation: over.text ?? "Hola" },
      ...over,
    }) as WAMessage;

  it("normaliza solo mensajes de texto entrantes de contactos", () => {
    expect(normalizeBaileysMessage(msg({}))).toEqual({
      jid: "34600111222@s.whatsapp.net",
      phone: "34600111222",
      contactId: "34600111222",
      id: "BAE5.1",
      name: "Ana",
      text: "Hola",
    });
    expect(normalizeBaileysMessage(msg({ key: { remoteJid: "34600111222@s.whatsapp.net", fromMe: true, id: "x" } }))).toBeNull();
    expect(normalizeBaileysMessage(msg({ key: { remoteJid: "123-456@g.us", fromMe: false, id: "x" } }))).toBeNull();
    expect(normalizeBaileysMessage({ ...msg({}), message: { imageMessage: {} } } as WAMessage)).toBeNull();
  });

  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "ega-baileys-"));
  });

  it("sesión: QR → vinculada → mensajes a la cola → envío; cierre de sesión desde el teléfono → ERROR", async () => {
    const queue = new RecordingQueue();
    const ctx = testContext({ queue });
    contexts.push(ctx);
    await resetDb(ctx);
    const ev = new EventEmitter();
    const sent: Array<{ jid: string; text: string }> = [];
    const socket: BaileysSocketLike = {
      ev,
      async sendMessage(jid, content) {
        sent.push({ jid, text: content.text });
        return { key: { id: "BAE5.OUT" } };
      },
      end: () => undefined,
      logout: async () => undefined,
    };
    const manager = new BaileysSessionManager({
      db: ctx.db,
      bus: ctx.bus,
      queue,
      log: ctx.log,
      dataDir,
      factory: async () => ({ socket, saveCreds: async () => undefined }),
    });

    const ws = await ctx.db.workspace.create({ data: { name: "bl", slug: "bl" } });
    const agent = await seedAgent(ctx, ws.id);
    const conn = await ctx.connections.create(ws.id, { kind: "channel.whatsapp_baileys", name: "wa-qr", config: { agentId: agent.id } }, systemActor);
    await manager.start(conn.id);

    ev.emit("connection.update", { qr: "2@QRDATA" });
    await waitFor(async () => ctx.db.event.findFirst({ where: { type: "channel.qr", subject: `connection:${conn.id}` } }));
    ev.emit("connection.update", { connection: "open" });
    await waitFor(async () => (await ctx.db.connection.findUniqueOrThrow({ where: { id: conn.id } })).status === "OK");
    expect(manager.isOpen(conn.id)).toBe(true);

    ev.emit("messages.upsert", { type: "notify", messages: [msg({ text: "¿Abrís el sábado?" })] });
    await waitFor(async () => queue.jobs.length > 0);
    expect(queue.take("channel.inbound")[0]?.data).toMatchObject({
      connectionId: conn.id,
      externalThreadId: "34600111222@s.whatsapp.net",
      channelMessageId: "BAE5.1",
      text: "¿Abrís el sábado?",
    });

    expect(await manager.send(conn.id, "34600111222@s.whatsapp.net", "Sí, de 10 a 14")).toBe("BAE5.OUT");
    expect(sent).toEqual([{ jid: "34600111222@s.whatsapp.net", text: "Sí, de 10 a 14" }]);

    ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await waitFor(async () => (await ctx.db.connection.findUniqueOrThrow({ where: { id: conn.id } })).status === "ERROR");
    await expect(manager.send(conn.id, "x@s.whatsapp.net", "y")).rejects.toThrow(/no está conectada/);
    await rm(dataDir, { recursive: true, force: true });
  });
});
