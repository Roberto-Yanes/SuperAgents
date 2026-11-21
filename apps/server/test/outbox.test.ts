import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeContext, type AppContext } from "../src/container.js";
import { handleMessageOutbound } from "../src/execution/workers/message-outbound.js";
import { ChannelDeliveryUnknownError, ChannelRegistry, RetryableChannelError, type ChannelAdapter } from "../src/integrations/channels/adapter.js";
import { whatsappCloudAdapter } from "../src/integrations/channels/whatsapp-cloud.js";
import { builtinTools } from "../src/integrations/tools/builtin/index.js";
import { ToolRegistry } from "../src/integrations/tools/registry.js";
import { defineTool, type ToolDef } from "../src/integrations/tools/types.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { RecordingQueue, resetDb, scriptedModel, seedAgent, testContext, type ScriptedTurn } from "./helpers.js";

/** Regresiones de la revisión (bloque outbox): H3 (aprobaciones y tools con efectos) y H4 (envíos). */
let ctx: AppContext;
let queue: RecordingQueue;
beforeAll(async () => {
  queue = new RecordingQueue();
  ctx = testContext({ queue });
  await resetDb(ctx);
});
afterAll(async () => closeContext(ctx));

async function queuedMessage() {
  const ws = await ctx.db.workspace.create({ data: { name: "o", slug: `o-${Date.now()}-${Math.random()}` } });
  const agent = await seedAgent(ctx, ws.id);
  const conn = await ctx.db.connection.create({ data: { workspaceId: ws.id, kind: "channel.fake", name: "fake", config: {} } });
  const conv = await ctx.db.conversation.create({
    data: { workspaceId: ws.id, agentId: agent.id, channel: "fake", connectionId: conn.id, externalThreadId: "t1" },
  });
  const msg = await ctx.db.message.create({
    data: { workspaceId: ws.id, conversationId: conv.id, direction: "OUTBOUND", author: "AGENT", text: "hola", status: "QUEUED" },
  });
  return { ws, conv, msg };
}

function fakeChannel(behaviour: () => Promise<{ channelMessageId: string }>) {
  const calls: string[] = [];
  const adapter: ChannelAdapter = {
    channel: "fake",
    connectionKind: "channel.fake",
    async send(m) {
      calls.push(m.idempotencyKey);
      return behaviour();
    },
  };
  return { deps: { db: ctx.db, bus: ctx.bus, secretKeys: ctx.secretKeys, channels: new ChannelRegistry().register(adapter) }, calls };
}

describe("H4 · envíos salientes", () => {
  it("dos workers a la vez: el mensaje se envía una sola vez", async () => {
    const { ws, msg } = await queuedMessage();
    const { deps, calls } = fakeChannel(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { channelMessageId: "ch-1" };
    });
    await Promise.all([
      handleMessageOutbound(deps, { workspaceId: ws.id, messageId: msg.id }),
      handleMessageOutbound(deps, { workspaceId: ws.id, messageId: msg.id }),
    ]);
    expect(calls).toHaveLength(1);
    expect(await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } })).toMatchObject({ status: "SENT", channelMessageId: "ch-1" });
  });

  it("timeout del proveedor → UNKNOWN, sin reintento ni reenvío", async () => {
    const { ws, msg, conv } = await queuedMessage();
    const { deps, calls } = fakeChannel(async () => Promise.reject(new ChannelDeliveryUnknownError("timeout")));
    await handleMessageOutbound(deps, { workspaceId: ws.id, messageId: msg.id }); // no lanza: no hay reintento
    await handleMessageOutbound(deps, { workspaceId: ws.id, messageId: msg.id });
    expect(calls).toHaveLength(1);
    expect((await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("UNKNOWN");
    expect(await ctx.db.event.findFirst({ where: { subject: `conversation:${conv.id}`, type: "message.unknown" } })).not.toBeNull();
  });

  it("un job que encuentra el mensaje en SENDING (caída a mitad) lo marca UNKNOWN y no reenvía", async () => {
    const { ws, msg } = await queuedMessage();
    await ctx.db.message.update({ where: { id: msg.id }, data: { status: "SENDING" } });
    const { deps, calls } = fakeChannel(async () => ({ channelMessageId: "x" }));
    await handleMessageOutbound(deps, { workspaceId: ws.id, messageId: msg.id }, 1);
    expect(calls).toHaveLength(0);
    expect((await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("UNKNOWN");
  });

  it("error temporal con certeza de no envío → vuelve a QUEUED y el reintento lo envía", async () => {
    const { ws, msg } = await queuedMessage();
    let n = 0;
    const { deps, calls } = fakeChannel(async () => (n++ === 0 ? Promise.reject(new RetryableChannelError("429")) : { channelMessageId: "ok" }));
    await expect(handleMessageOutbound(deps, { workspaceId: ws.id, messageId: msg.id }, 0)).rejects.toBeInstanceOf(RetryableChannelError);
    expect((await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("QUEUED");
    await handleMessageOutbound(deps, { workspaceId: ws.id, messageId: msg.id }, 1);
    expect(calls).toHaveLength(2);
    expect((await ctx.db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("SENT");
  });

  it("Cloud API: sin conexión → reintentable; timeout → desconocido", async () => {
    const send = (err: unknown) =>
      whatsappCloudAdapter(async () => Promise.reject(err)).send(
        { workspaceId: "w", conversationId: "c", externalThreadId: "34600", text: "hola", idempotencyKey: "k" },
        { id: "c", config: { phoneNumberId: "1", graphApiVersion: "v23.0" }, secret: { accessToken: "t" } },
      );
    await expect(send(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).rejects.toBeInstanceOf(RetryableChannelError);
    await expect(send(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).rejects.toBeInstanceOf(ChannelDeliveryUnknownError);
  });
});

describe("H3 · acciones con efectos que no se repiten", () => {
  let sent: string[] = [];
  const sendEmail = (approval: "NEVER" | "ASK_OWNER") =>
    defineTool({
      name: "email.send",
      description: "Envía un correo",
      input: z.object({ to: z.string() }),
      scope: "channel:send",
      risk: "send",
      approval,
      async execute(i) {
        sent.push(i.to);
        return { ok: true };
      },
    });

  function local(turns: ScriptedTurn[], approval: "NEVER" | "ASK_OWNER") {
    sent = [];
    const tools = new ToolRegistry();
    for (const t of [...builtinTools, sendEmail(approval) as ToolDef]) tools.register(t);
    const scripted = scriptedModel(turns);
    return { c: testContext({ tools, queue: new RecordingQueue(), llm: new StaticLlmResolver(scripted.model) }), scripted };
  }

  async function chat(c: AppContext) {
    const ws = await c.db.workspace.create({ data: { name: "h3", slug: `h3-${Date.now()}-${Math.random()}` } });
    const agent = await seedAgent(c, ws.id, ["email.send"]);
    const { id: conversationId } = await c.conversations.createApiChat(ws.id, agent.id);
    const r = await c.conversations.receive({ workspaceId: ws.id, conversationId, text: "manda el correo", author: "HUMAN", trigger: "api.chat" });
    if (r.status !== "run_queued") throw new Error("sin run");
    return { ws, runId: r.runId };
  }

  it("aprobación en EXECUTING tras una caída → UNKNOWN; la tool no se vuelve a ejecutar", async () => {
    const { c } = local([{ toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com" } }] }, { text: "Lo revisará el equipo." }], "ASK_OWNER");
    try {
      const { ws, runId } = await chat(c);
      await c.runtime.execute(ws.id, runId);
      const approval = await c.db.approval.findFirstOrThrow({ where: { runId } });
      await c.db.approval.update({ where: { id: approval.id }, data: { status: "EXECUTING" } }); // proceso muerto a mitad
      await c.runtime.resume(ws.id, runId);
      expect(sent).toEqual([]);
      expect((await c.db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("UNKNOWN");
      expect(await c.db.event.findFirst({ where: { subject: `run:${runId}`, type: "approval.unknown" } })).not.toBeNull();
      expect((await c.db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("SUCCEEDED");
    } finally {
      await closeContext(c);
    }
  });

  it("dos reanudaciones de la misma aprobación ejecutan la acción una sola vez", async () => {
    const { c } = local([{ toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com" } }] }, { text: "Hecho." }, { text: "Hecho." }], "ASK_OWNER");
    try {
      const { ws, runId } = await chat(c);
      await c.runtime.execute(ws.id, runId);
      const approval = await c.db.approval.findFirstOrThrow({ where: { runId } });
      await c.db.approval.update({ where: { id: approval.id }, data: { status: "APPROVED" } });
      await c.db.run.update({ where: { id: runId }, data: { status: "RUNNING" } }); // como si dos workers recuperaran el run
      await Promise.all([c.runtime.execute(ws.id, runId, 1), c.runtime.execute(ws.id, runId, 1)]);
      expect(sent).toEqual(["ana@x.com"]);
    } finally {
      await closeContext(c);
    }
  });

  it("recuperar un run desde el checkpoint no repite una tool sin aprobación ya ejecutada, ni duplica la respuesta", async () => {
    const turns: ScriptedTurn[] = [
      { toolCalls: [{ id: "c1", name: "email__send", input: { to: "ana@x.com" } }] },
      { text: "Enviado." },
      { toolCalls: [{ id: "c9", name: "email__send", input: { to: "ana@x.com" } }] }, // el modelo repite la llamada al recuperar
      { text: "Enviado." },
    ];
    const { c } = local(turns, "NEVER");
    try {
      const { ws, runId } = await chat(c);
      await c.runtime.execute(ws.id, runId);
      expect(sent).toEqual(["ana@x.com"]);
      // Simula la caída antes de guardar el checkpoint: el run vuelve a RUNNING desde el principio.
      await c.db.run.update({ where: { id: runId }, data: { status: "RUNNING", checkpoint: [], stepCount: 0 } });
      await c.runtime.execute(ws.id, runId, 1);
      expect(sent).toEqual(["ana@x.com"]); // no se reenvió
      expect(await c.db.runStep.findFirst({ where: { runId, kind: "note", toolCallId: "c9" } })).toMatchObject({ data: { dedupeOf: "c1", replayed: true } });
      expect(await c.db.message.count({ where: { runId, direction: "OUTBOUND" } })).toBe(1); // reply:<runId> idempotente
    } finally {
      await closeContext(c);
    }
  });
});
