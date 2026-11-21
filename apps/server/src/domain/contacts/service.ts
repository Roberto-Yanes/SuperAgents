import { z } from "zod";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import { audit, type Actor } from "../../data/audit.js";
import { notFound } from "../../shared/errors.js";

export const ContactInput = z.object({
  name: z.string().max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(32).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type ContactInput = z.infer<typeof ContactInput>;

export class ContactService {
  constructor(private readonly db: Db) {}

  list(workspaceId: string, q?: { search?: string; tag?: string; limit?: number; cursor?: string }) {
    const where: Prisma.ContactWhereInput = { workspaceId };
    if (q?.search) {
      where.OR = [
        { name: { contains: q.search, mode: "insensitive" } },
        { email: { contains: q.search, mode: "insensitive" } },
        { phone: { contains: q.search } },
      ];
    }
    if (q?.tag) where.tags = { has: q.tag };
    return this.db.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(q?.limit ?? 50, 200),
      ...(q?.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  }

  async get(workspaceId: string, id: string) {
    const contact = await this.db.contact.findFirst({ where: { id, workspaceId } });
    if (!contact) throw notFound("Contacto");
    return contact;
  }

  async create(workspaceId: string, input: ContactInput, actor: Actor) {
    const contact = await this.db.contact.create({
      data: {
        workspaceId,
        name: input.name ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        tags: input.tags ?? [],
        attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
        externalIds: { ...(input.email ? { email: input.email } : {}), ...(input.phone ? { whatsapp: input.phone.replace(/\D/g, "") } : {}) },
      },
    });
    await audit(this.db, { workspaceId, actor, action: "contact.created", target: `contact:${contact.id}` });
    return contact;
  }

  async update(workspaceId: string, id: string, input: ContactInput, actor: Actor) {
    await this.get(workspaceId, id);
    const contact = await this.db.contact.update({
      where: { id },
      data: {
        name: input.name,
        email: input.email,
        phone: input.phone,
        tags: input.tags,
        attributes: input.attributes as Prisma.InputJsonValue | undefined,
      },
    });
    await audit(this.db, { workspaceId, actor, action: "contact.updated", target: `contact:${id}`, data: { fields: Object.keys(input) } });
    return contact;
  }

  /** Borrado (derecho de supresión): elimina contacto, memoria, leads y citas en cascada; conserva conversaciones anonimizadas. */
  async remove(workspaceId: string, id: string, actor: Actor): Promise<void> {
    await this.get(workspaceId, id);
    await this.db.$transaction([
      this.db.conversation.updateMany({ where: { workspaceId, contactId: id }, data: { contactId: null } }),
      this.db.appointment.updateMany({ where: { workspaceId, contactId: id }, data: { contactId: null } }),
      this.db.sequenceEnrollment.updateMany({
        where: { workspaceId, contactId: id },
        data: { contactId: null, status: "STOPPED", stoppedReason: "contact_deleted" },
      }),
      this.db.contact.delete({ where: { id } }),
    ]);
    await audit(this.db, { workspaceId, actor, action: "contact.deleted", target: `contact:${id}` });
  }

  memories(workspaceId: string, contactId: string) {
    return this.db.memory.findMany({
      where: { workspaceId, contactId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, key: true, content: true, source: true, agentId: true, updatedAt: true },
    });
  }
}

/** Busca el contacto por su id en un canal (p. ej. número de WhatsApp) o lo crea. */
/**
 * Busca o crea el contacto por su id de canal. El teléfono solo se guarda si el canal lo da explícitamente
 * (input.phone) o si el externalId de WhatsApp es un número; un LID ("lid:...") nunca se toma por teléfono (L9).
 */
export async function upsertContactByChannel(db: Db, input: { workspaceId: string; channel: string; externalId: string; phone?: string; name?: string }) {
  const existing = await db.contact.findFirst({
    where: { workspaceId: input.workspaceId, externalIds: { path: [input.channel], equals: input.externalId } },
  });
  if (existing) {
    const patch = {
      ...(!existing.name && input.name ? { name: input.name } : {}),
      ...(!existing.phone && input.phone ? { phone: input.phone } : {}),
    };
    return Object.keys(patch).length ? db.contact.update({ where: { id: existing.id }, data: patch }) : existing;
  }
  return db.contact.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name ?? null,
      phone: input.phone ?? (input.channel === "whatsapp" && /^\d{6,15}$/.test(input.externalId) ? input.externalId : null),
      email: input.channel === "email" ? input.externalId : null,
      externalIds: { [input.channel]: input.externalId },
    },
  });
}
