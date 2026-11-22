import { z } from "zod";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import { audit, type Actor } from "../../data/audit.js";
import { invalid, notFound } from "../../shared/errors.js";

/** Retención por workspace (ADR 005). Default 12 meses; el tenant puede bajarla, nunca subirla. */
export const RetentionSchema = z
  .object({
    /** Mensajes, tareas y pasos de runs. */
    contentDays: z.number().int().min(1).max(365).optional(),
    /** Registro de auditoría (metadatos, sin prompts). Mínimo 30 días para poder investigar un incidente. */
    auditDays: z.number().int().min(30).max(365).optional(),
  })
  .strict();
export type Retention = z.infer<typeof RetentionSchema>;
export const DEFAULT_RETENTION_DAYS = 365;
/** El backlog del bus de eventos (reconexión de clientes) no necesita más. */
export const EVENT_RETENTION_DAYS = 30;

export function retentionOf(settings: unknown): Required<Retention> {
  const r = RetentionSchema.safeParse((settings as { retention?: unknown } | null)?.retention ?? {});
  const v = r.success ? r.data : {};
  return { contentDays: v.contentDays ?? DEFAULT_RETENTION_DAYS, auditDays: v.auditDays ?? DEFAULT_RETENTION_DAYS };
}

const REDACTED = "[dato personal eliminado]";

/**
 * Derechos RGPD sobre un contacto (ADR 005, E8):
 * - export(): todo lo que el producto guarda de esa persona, en un JSON.
 * - erase(): borra sus mensajes, conversaciones, memoria, leads, citas, tareas de canal y eventos del bus, y
 *   tacha sus datos en las notas del agente. Queda en la auditoría solo el recuento (sin datos personales).
 * - retentionSweep(): purga diaria de contenido y auditoría vencidos según la retención de cada workspace.
 */
export class PrivacyService {
  constructor(private readonly d: { db: Db; system: Db }) {}

  async export(workspaceId: string, contactId: string, actor: Actor): Promise<Record<string, unknown>> {
    const contact = await this.d.db.contact.findFirst({ where: { id: contactId, workspaceId }, include: { identities: true } });
    if (!contact) throw notFound("Contacto");
    const conversations = await this.d.db.conversation.findMany({
      where: { workspaceId, contactId },
      include: { messages: { orderBy: { createdAt: "asc" }, select: { id: true, direction: true, author: true, text: true, status: true, createdAt: true } } },
    });
    const conversationIds = conversations.map((c) => c.id);
    const [memories, leads, appointments, tasks] = await Promise.all([
      this.d.db.memory.findMany({ where: { workspaceId, contactId }, select: { key: true, content: true, source: true, createdAt: true, updatedAt: true } }),
      this.d.db.lead.findMany({ where: { workspaceId, contactId }, include: { stage: { select: { name: true } } } }),
      this.d.db.appointment.findMany({ where: { workspaceId, OR: [{ contactId }, { conversationId: { in: conversationIds } }] } }),
      this.d.db.task.findMany({
        where: { workspaceId, OR: [{ contactId }, { conversationId: { in: conversationIds } }] },
        select: { id: true, source: true, goal: true, status: true, result: true, createdAt: true, finishedAt: true },
      }),
    ]);
    await audit(this.d.db, { workspaceId, actor, action: "privacy.contact_exported", target: `contact:${contactId}` });
    return {
      exportedAt: new Date().toISOString(),
      contact: { id: contact.id, name: contact.name, phone: contact.phone, email: contact.email, createdAt: contact.createdAt },
      identities: contact.identities.map((i) => ({ channel: i.channel, externalId: i.externalId })),
      conversations: conversations.map((c) => ({ id: c.id, channel: c.channel, status: c.status, createdAt: c.createdAt, messages: c.messages })),
      memories,
      leads: leads.map((l) => ({ id: l.id, title: l.title, stage: l.stage.name, value: l.value, createdAt: l.createdAt })),
      appointments: appointments.map((a) => ({ id: a.id, title: a.title, startsAt: a.startsAt, endsAt: a.endsAt, status: a.status, notes: a.notes })),
      tasks,
    };
  }

  async erase(workspaceId: string, contactId: string, actor: Actor): Promise<Record<string, number>> {
    const contact = await this.d.db.contact.findFirst({ where: { id: contactId, workspaceId }, include: { identities: true } });
    if (!contact) throw notFound("Contacto");
    const conversations = await this.d.db.conversation.findMany({ where: { workspaceId, contactId }, select: { id: true } });
    const convIds = conversations.map((c) => c.id);
    const needles = [contact.name, contact.phone, contact.email, ...contact.identities.map((i) => i.externalId)]
      .filter((x): x is string => typeof x === "string" && x.trim().length >= 4)
      .map((x) => x.trim());

    const counts = await this.d.db.$transaction(async (tx) => {
      const runs = await tx.run.findMany({ where: { workspaceId, conversationId: { in: convIds } }, select: { id: true } });
      const runIds = runs.map((r) => r.id);
      // Tareas de canal de esta persona (las de la app que la citan solo pierden el vínculo: contactId → null).
      const appTasks = await tx.task.findMany({ where: { workspaceId, contactId, source: { not: "CHANNEL" } }, select: { id: true } });
      const tasks = await tx.task.deleteMany({ where: { workspaceId, source: "CHANNEL", OR: [{ contactId }, { conversationId: { in: convIds } }] } });
      const events = await tx.event.deleteMany({
        where: { workspaceId, subject: { in: [...convIds.map((id) => `conversation:${id}`), ...runIds.map((id) => `run:${id}`)] } },
      });
      await tx.run.deleteMany({ where: { workspaceId, id: { in: runIds } } }); // pasos y aprobaciones en cascada
      const appointments = await tx.appointment.deleteMany({ where: { workspaceId, OR: [{ contactId }, { conversationId: { in: convIds } }] } });
      const messages = await tx.message.count({ where: { workspaceId, conversationId: { in: convIds } } });
      await tx.conversation.deleteMany({ where: { workspaceId, id: { in: convIds } } }); // mensajes e inscripciones en cascada
      const memories = await tx.memory.deleteMany({ where: { workspaceId, contactId } });
      const leads = await tx.lead.deleteMany({ where: { workspaceId, contactId } });
      // Notas del agente que citan a esta persona: se tachan sus datos, sin reescribir lo demás.
      let notes = 0;
      if (needles.length) {
        const candidates = await tx.memory.findMany({
          where: {
            workspaceId,
            contactId: null,
            OR: needles.flatMap((n) => [{ content: { contains: n, mode: "insensitive" as const } }, { key: { contains: n, mode: "insensitive" as const } }]),
          },
        });
        for (const m of candidates) {
          await tx.memory.update({ where: { id: m.id }, data: { content: scrub(m.content, needles), key: scrub(m.key, needles).slice(0, 200) } });
          notes += 1;
        }
      }
      await tx.contact.delete({ where: { id: contactId } }); // identidades en cascada
      return {
        conversations: convIds.length,
        messages,
        runs: runIds.length,
        tasks: tasks.count,
        events: events.count,
        appointments: appointments.count,
        memories: memories.count,
        leads: leads.count,
        notesRedacted: notes,
        appTasksUnlinked: appTasks.length,
      };
    });
    await audit(this.d.db, { workspaceId, actor, action: "privacy.contact_erased", target: `contact:${contactId}`, data: counts as Prisma.InputJsonValue });
    return counts;
  }

  async setRetention(workspaceId: string, input: unknown, actor: Actor): Promise<Required<Retention>> {
    const parsed = RetentionSchema.safeParse(input);
    if (!parsed.success) throw invalid("retention_invalid", "Retención inválida: máximo 365 días (auditoría, mínimo 30)", parsed.error.issues);
    const ws = await this.d.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const settings = (ws.settings ?? {}) as Record<string, unknown>;
    await this.d.db.workspace.update({ where: { id: workspaceId }, data: { settings: { ...settings, retention: parsed.data } as Prisma.InputJsonValue } });
    await audit(this.d.db, { workspaceId, actor, action: "privacy.retention_updated", target: `workspace:${workspaceId}`, data: parsed.data });
    return retentionOf({ retention: parsed.data });
  }

  /** Job diario retention.sweep. Cruza workspaces: cliente de sistema. */
  async retentionSweep(now = new Date()): Promise<{ workspaces: number; messages: number; tasks: number; runs: number; events: number; audit: number }> {
    const total = { workspaces: 0, messages: 0, tasks: 0, runs: 0, events: 0, audit: 0 };
    const day = 86_400_000;
    const events = await this.d.system.event.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - EVENT_RETENTION_DAYS * day) } } });
    total.events = events.count;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.d.system.workspace.findMany({
        select: { id: true, settings: true },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!batch.length) break;
      for (const ws of batch) {
        const r = retentionOf(ws.settings);
        const contentCut = new Date(now.getTime() - r.contentDays * day);
        const auditCut = new Date(now.getTime() - r.auditDays * day);
        const msgs = await this.d.system.message.deleteMany({ where: { workspaceId: ws.id, createdAt: { lt: contentCut } } });
        const runs = await this.d.system.run.deleteMany({
          where: { workspaceId: ws.id, status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"] }, finishedAt: { lt: contentCut } },
        });
        const tasks = await this.d.system.task.deleteMany({
          where: { workspaceId: ws.id, status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] }, finishedAt: { lt: contentCut } },
        });
        const logs = await this.d.system.auditLog.deleteMany({ where: { workspaceId: ws.id, createdAt: { lt: auditCut } } });
        total.messages += msgs.count;
        total.runs += runs.count;
        total.tasks += tasks.count;
        total.audit += logs.count;
        total.workspaces += 1;
      }
      cursor = batch.at(-1)!.id;
    }
    return total;
  }
}

function scrub(text: string, needles: string[]): string {
  let out = text;
  for (const n of needles) out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), REDACTED);
  return out;
}
