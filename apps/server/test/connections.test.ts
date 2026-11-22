import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { handleMessageOutbound } from "../src/execution/workers/message-outbound.js";
import { RetryableChannelError } from "../src/integrations/channels/adapter.js";
import { RecordingQueue, resetDb, seedAgent, seedWorkspace, testContext } from "./helpers.js";

/** fetch falso: responde según la URL y registra las llamadas. */
const calls: Array<{ url: string; init?: RequestInit }> = [];
let graphStatus = 200;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.includes("api.mistral.ai")) {
    const ok = (init?.headers as Record<string, string>)?.authorization === "Bearer sk-valid-key-123";
    return new Response(JSON.stringify(ok ? { data: [{ id: "mistral-medium-latest" }, { id: "mistral-small-latest" }] } : { error: "bad key" }), {
      status: ok ? 200 : 401,
    });
  }
  if (url.includes("graph.facebook.com") && url.endsWith("/messages")) {
    return new Response(JSON.stringify(graphStatus === 200 ? { messages: [{ id: "wamid.OUT1" }] } : { error: { message: "boom" } }), { status: graphStatus });
  }
  if (url.includes("graph.facebook.com"))
    return new Response(JSON.stringify({ display_phone_number: "+34 600 000 000", verified_name: "Clínica" }), { status: 200 });
  return new Response("not found", { status: 404 });
};

let ctx: AppContext;
let app: FastifyInstance;
let queue: RecordingQueue;

beforeAll(async () => {
  queue = new RecordingQueue();
  ctx = testContext({ queue, fetch: fakeFetch });
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
  calls.length = 0;
  graphStatus = 200;
});

describe("conexiones", () => {
  it("guarda el secreto cifrado y nunca lo devuelve", async () => {
    const w = await seedWorkspace(ctx, "c1");
    const res = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: w.auth,
      payload: { kind: "llm.mistral", name: "mistral-main", secret: { apiKey: "sk-valid-key-123" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("sk-valid-key-123");
    expect(res.json()).toMatchObject({ kind: "llm.mistral", hasSecret: true, status: "PENDING" });
    const row = await ctx.db.connection.findFirstOrThrow({ where: { workspaceId: w.workspace.id } });
    expect(Buffer.from(row.secretEnc!).toString("utf8")).not.toContain("sk-valid-key-123");
    const list = await app.inject({ method: "GET", url: "/v1/connections", headers: w.auth });
    expect(list.body).not.toContain("sk-valid-key-123");
  });

  it("valida config y secreto por tipo, y que el agente sea del workspace", async () => {
    const w = await seedWorkspace(ctx, "c2");
    const other = await seedWorkspace(ctx, "c2-otro");
    const foreignAgent = await seedAgent(ctx, other.workspace.id);
    const badKind = await app.inject({ method: "POST", url: "/v1/connections", headers: w.auth, payload: { kind: "llm.inventado", name: "x" } });
    expect(badKind.statusCode).toBe(400);
    const badSecret = await app.inject({ method: "POST", url: "/v1/connections", headers: w.auth, payload: { kind: "llm.mistral", name: "x", secret: {} } });
    expect(badSecret.statusCode).toBe(400);
    expect(badSecret.json().error.code).toBe("invalid_secret");
    const foreign = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: w.auth,
      payload: { kind: "channel.whatsapp_baileys", name: "wa", config: { agentId: foreignAgent.id } },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe("invalid_agent");
  });

  it("prueba de LLM: lista modelos sin gastar tokens y actualiza el estado", async () => {
    const w = await seedWorkspace(ctx, "c3");
    const good = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        headers: w.auth,
        payload: { kind: "llm.mistral", name: "ok", secret: { apiKey: "sk-valid-key-123" } },
      })
    ).json();
    const bad = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        headers: w.auth,
        payload: { kind: "llm.mistral", name: "ko", secret: { apiKey: "sk-wrong-key-000" } },
      })
    ).json();
    const t1 = await app.inject({ method: "POST", url: `/v1/connections/${good.id}/test`, headers: w.auth });
    expect(t1.json()).toMatchObject({ ok: true, details: { sampleModels: ["mistral-medium-latest", "mistral-small-latest"] } });
    const t2 = await app.inject({ method: "POST", url: `/v1/connections/${bad.id}/test`, headers: w.auth });
    expect(t2.json().ok).toBe(false);
    const rows = await ctx.db.connection.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { name: "asc" } });
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ["ko", "ERROR"],
      ["ok", "OK"],
    ]);
  });

  it("aislamiento: no se ve ni se prueba la conexión de otro workspace", async () => {
    const a = await seedWorkspace(ctx, "ca");
    const b = await seedWorkspace(ctx, "cb");
    const conn = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        headers: b.auth,
        payload: { kind: "llm.mistral", name: "x", secret: { apiKey: "sk-valid-key-123" } },
      })
    ).json();
    expect((await app.inject({ method: "GET", url: `/v1/connections/${conn.id}`, headers: a.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/connections/${conn.id}/test`, headers: a.auth })).statusCode).toBe(404);
  });
});

describe("sesión de WhatsApp por Baileys", () => {
  it("encola start/stop/logout solo para conexiones Baileys", async () => {
    const w = await seedWorkspace(ctx, "ses-bl");
    const agent = await seedAgent(ctx, w.workspace.id);
    const bl = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        headers: w.auth,
        payload: { kind: "channel.whatsapp_baileys", name: "wa-qr", config: { agentId: agent.id } },
      })
    ).json();
    const llm = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        headers: w.auth,
        payload: { kind: "llm.mistral", name: "llm", secret: { apiKey: "sk-valid-key-123" } },
      })
    ).json();
    const ok = await app.inject({ method: "POST", url: `/v1/connections/${bl.id}/session`, headers: w.auth, payload: { action: "start" } });
    expect(ok.statusCode).toBe(202);
    expect(queue.take("channel.session")[0]?.data).toEqual({ workspaceId: w.workspace.id, connectionId: bl.id, action: "start" });
    const ko = await app.inject({ method: "POST", url: `/v1/connections/${llm.id}/session`, headers: w.auth, payload: { action: "start" } });
    expect(ko.statusCode).toBe(400);
  });
});

describe("WhatsApp Cloud API", () => {
  async function setupCloud() {
    const w = await seedWorkspace(ctx, `wa-${Math.random().toString(36).slice(2, 8)}`);
    const agent = await seedAgent(ctx, w.workspace.id);
    const conn = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        headers: w.auth,
        payload: {
          kind: "channel.whatsapp_cloud",
          name: "wa-cloud",
          config: { agentId: agent.id, phoneNumberId: "1234567890" },
          secret: { accessToken: "EAAG-token-123", appSecret: "app-secret-xyz", verifyToken: "verify-me-123" },
        },
      })
    ).json();
    return { w, agent, conn };
  }

  const sign = (body: string, secret = "app-secret-xyz") => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const inbound = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "34600111222", profile: { name: "Ana" } }],
              messages: [{ from: "34600111222", id: "wamid.IN1", type: "text", text: { body: "Hola, ¿tenéis cita mañana?" } }],
            },
          },
        ],
      },
    ],
  });

  it("expone la URL del webhook y verifica la suscripción de Meta", async () => {
    const { conn } = await setupCloud();
    expect(conn.hints.webhookUrl).toBe(`${ctx.env.PUBLIC_URL}/webhooks/whatsapp/${conn.id}`);
    const ok = await app.inject({ method: "GET", url: `/webhooks/whatsapp/${conn.id}?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=42` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("42");
    const ko = await app.inject({ method: "GET", url: `/webhooks/whatsapp/${conn.id}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=42` });
    expect(ko.statusCode).toBe(403);
  });

  it("rechaza webhooks sin firma válida y encola los firmados", async () => {
    const { w, conn } = await setupCloud();
    const bad = await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${conn.id}`,
      payload: inbound,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(inbound, "otro-secreto") },
    });
    expect(bad.statusCode).toBe(401);
    expect(queue.jobs).toHaveLength(0);

    const good = await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${conn.id}`,
      payload: inbound,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(inbound) },
    });
    expect(good.statusCode).toBe(200);
    const [job] = queue.take("channel.inbound");
    expect(job?.data).toMatchObject({
      workspaceId: w.workspace.id,
      connectionId: conn.id,
      channel: "whatsapp",
      externalThreadId: "34600111222",
      channelMessageId: "wamid.IN1",
      from: { id: "34600111222", name: "Ana" },
      text: "Hola, ¿tenéis cita mañana?",
    });
  });

  it("el outbox envía por la conexión de la conversación; reintenta errores temporales y respeta la ventana de 24 h", async () => {
    const { w, agent, conn } = await setupCloud();
    const chat = await ctx.db.conversation.create({
      data: {
        workspaceId: w.workspace.id,
        agentId: agent.id,
        channel: "whatsapp",
        connectionId: conn.id,
        externalThreadId: "34600111222",
        lastInboundAt: new Date(),
      },
    });
    const msg = await ctx.db.message.create({
      data: { workspaceId: w.workspace.id, conversationId: chat.id, direction: "OUTBOUND", author: "AGENT", text: "¡Claro!", status: "QUEUED" },
    });

    graphStatus = 503;
    await expect(handleMessageOutbound(ctx, { workspaceId: w.workspace.id, messageId: msg.id }, 0)).rejects.toBeInstanceOf(RetryableChannelError);
    expect((await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("QUEUED");

    graphStatus = 200;
    await handleMessageOutbound(ctx, { workspaceId: w.workspace.id, messageId: msg.id }, 1);
    const sent = await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } });
    expect(sent).toMatchObject({ status: "SENT", channelMessageId: "wamid.OUT1" });
    const sendCall = calls.find((c) => c.url.endsWith("/1234567890/messages"))!;
    expect(JSON.parse(String(sendCall.init?.body))).toMatchObject({ to: "34600111222", text: { body: "¡Claro!" } });
    // segundo intento sobre un mensaje ya enviado: no hace nada
    await handleMessageOutbound(ctx, { workspaceId: w.workspace.id, messageId: msg.id }, 0);
    expect(calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(2);

    await ctx.db.conversation.update({ where: { id: chat.id }, data: { lastInboundAt: new Date(Date.now() - 25 * 3_600_000) } });
    const late = await ctx.db.message.create({
      data: { workspaceId: w.workspace.id, conversationId: chat.id, direction: "OUTBOUND", author: "AGENT", text: "tarde", status: "QUEUED" },
    });
    await handleMessageOutbound(ctx, { workspaceId: w.workspace.id, messageId: late.id }, 0);
    const failed = await ctx.db.message.findUniqueOrThrow({ where: { id: late.id } });
    expect(failed.status).toBe("FAILED");
    expect(JSON.stringify(failed.payload)).toContain("24 h");
  });

  it("los estados de entrega de Meta actualizan el mensaje saliente", async () => {
    const { w, agent, conn } = await setupCloud();
    const chat = await ctx.db.conversation.create({
      data: { workspaceId: w.workspace.id, agentId: agent.id, channel: "whatsapp", connectionId: conn.id, externalThreadId: "346" },
    });
    const msg = await ctx.db.message.create({
      data: {
        workspaceId: w.workspace.id,
        conversationId: chat.id,
        direction: "OUTBOUND",
        author: "AGENT",
        text: "x",
        status: "SENT",
        channelMessageId: "wamid.OUT9",
      },
    });
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.OUT9", status: "read" }] } }] }] });
    await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${conn.id}`,
      payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    });
    expect((await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("READ");
  });
});
