import { taskTools } from "./tasks.js";
import { z } from "zod";
import { defineTool, type ToolDef } from "../types.js";

/**
 * Tools internas del producto. Las de apps externas llegan por el Composio Gateway (integrations/composio/gateway.ts).
 *
 * Memorias (L8): con un contacto se guardan por (agente, contacto). En chats internos (API/UI, sin contacto) se guardan
 * con contactId null = "notas del equipo" del agente, compartidas entre los chats internos de ese agente. Nunca se
 * leen ni escriben notas de equipo desde la cara externa.
 */

const NO_CONTACT = { ok: false as const, error: "No hay un contacto identificado en esta conversación; no se puede usar la memoria." };

export const memorySave = defineTool({
  name: "memory.save",
  description: "Guarda un hecho útil sobre el contacto actual (preferencias, datos, acuerdos). Sobrescribe si la clave existe.",
  input: z.object({ key: z.string().min(1).max(80), content: z.string().min(1).max(2000) }),
  scope: "memory:write",
  risk: "write",
  exposure: "external",
  approval: "NEVER",
  async execute({ key, content }, ctx) {
    const agentId = ctx.agentId;
    const contactId = ctx.contactId;
    if (ctx.face === "external" && !contactId) return NO_CONTACT;
    const existing = await ctx.db.memory.findFirst({ where: { workspaceId: ctx.workspaceId, agentId, contactId, key } });
    if (existing) {
      await ctx.db.memory.update({ where: { id: existing.id }, data: { content } });
    } else {
      await ctx.db.memory.create({ data: { workspaceId: ctx.workspaceId, agentId, contactId, key, content } });
    }
    return { ok: true, saved: key };
  },
});

export const memoryRecall = defineTool({
  name: "memory.recall",
  description: "Busca hechos guardados sobre el contacto actual. Devuelve hasta 20.",
  input: z.object({ query: z.string().max(200).optional() }),
  scope: "memory:read",
  risk: "read",
  exposure: "external",
  approval: "NEVER",
  async execute({ query }, ctx) {
    if (ctx.face === "external" && !ctx.contactId) return NO_CONTACT;
    const items = await ctx.db.memory.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        contactId: ctx.contactId,
        ...(query ? { OR: [{ key: { contains: query, mode: "insensitive" } }, { content: { contains: query, mode: "insensitive" } }] } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    return { ok: true, items: items.map((m) => ({ key: m.key, content: m.content })) };
  },
});

export const handoffRequest = defineTool({
  name: "handoff.request",
  description: "Pasa la conversación a una persona del equipo cuando no puedas resolver o el contacto lo pida.",
  input: z.object({ reason: z.string().min(1).max(500) }),
  scope: "chats:write",
  risk: "write",
  exposure: "external",
  approval: "NEVER",
  async execute({ reason }, ctx) {
    if (!ctx.conversationId) return { ok: false, error: "No hay conversación asociada" };
    await ctx.db.conversation.update({
      where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
      data: { status: "HANDOFF" },
    });
    await ctx.bus.publish({
      workspaceId: ctx.workspaceId,
      type: "conversation.handoff",
      subject: `conversation:${ctx.conversationId}`,
      data: { reason, runId: ctx.runId },
    });
    return { ok: true, handedOff: true };
  },
});

export const contactUpdate = defineTool({
  name: "contact.update",
  description: "Actualiza nombre, email o teléfono del contacto actual con datos que el propio contacto ha dado.",
  input: z.object({ name: z.string().max(120).optional(), email: z.string().email().optional(), phone: z.string().max(32).optional() }),
  scope: "contacts:write",
  risk: "write",
  exposure: "external",
  approval: "NEVER",
  async execute(input, ctx) {
    if (!ctx.contactId) return { ok: false, error: "No hay contacto asociado" };
    await ctx.db.contact.update({ where: { id: ctx.contactId, workspaceId: ctx.workspaceId }, data: input });
    return { ok: true, updated: Object.keys(input) };
  },
});

export const builtinTools: ToolDef[] = [memorySave, memoryRecall, handoffRequest, contactUpdate, ...taskTools] as ToolDef[];
