import { z } from "zod";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import type { EventBus } from "../../execution/events/bus.js";
import { JOBS, type JobQueue } from "../../execution/queue/jobs.js";
import { audit, type Actor } from "../../data/audit.js";
import { conflict, invalid, notFound } from "../../shared/errors.js";

export const DEFAULT_STAGES: Array<{ name: string; kind: "OPEN" | "WON" | "LOST" }> = [
  { name: "Nuevo", kind: "OPEN" },
  { name: "Contactado", kind: "OPEN" },
  { name: "Propuesta", kind: "OPEN" },
  { name: "Ganado", kind: "WON" },
  { name: "Perdido", kind: "LOST" },
];

export const LeadInput = z.object({
  contactId: z.string().uuid(),
  title: z.string().min(1).max(200),
  stage: z.string().max(80).optional(),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  source: z.string().max(80).optional(),
  notes: z.string().max(5000).optional(),
});
export type LeadInput = z.infer<typeof LeadInput>;

export const LeadPatch = LeadInput.omit({ contactId: true }).partial();
export type LeadPatch = z.infer<typeof LeadPatch>;

/** Embudo de ventas. Cada cambio publica un evento y, si el workspace tiene CRM configurado, encola crm.sync. */
export class LeadService {
  constructor(private readonly d: { db: Db; bus: EventBus; queue: JobQueue }) {}

  async stages(workspaceId: string) {
    const stages = await this.d.db.pipelineStage.findMany({ where: { workspaceId }, orderBy: { position: "asc" } });
    if (stages.length > 0) return stages;
    await this.setStages(workspaceId, DEFAULT_STAGES);
    return this.d.db.pipelineStage.findMany({ where: { workspaceId }, orderBy: { position: "asc" } });
  }

  /** Reemplaza el embudo. No permite quitar etapas con leads. */
  async setStages(workspaceId: string, stages: Array<{ name: string; kind: "OPEN" | "WON" | "LOST" }>) {
    if (stages.length === 0) throw invalid("empty_pipeline", "El embudo necesita al menos una etapa");
    const names = new Set(stages.map((s) => s.name));
    if (names.size !== stages.length) throw invalid("duplicate_stage", "Hay etapas repetidas");
    const existing = await this.d.db.pipelineStage.findMany({ where: { workspaceId }, include: { _count: { select: { leads: true } } } });
    const removed = existing.filter((e) => !names.has(e.name));
    const blocked = removed.filter((e) => e._count.leads > 0);
    if (blocked.length) throw conflict("stage_in_use", `Hay leads en: ${blocked.map((b) => b.name).join(", ")}`);
    await this.d.db.$transaction(async (tx) => {
      await tx.pipelineStage.deleteMany({ where: { workspaceId, id: { in: removed.map((r) => r.id) } } });
      for (const [position, s] of stages.entries()) {
        await tx.pipelineStage.upsert({
          where: { workspaceId_name: { workspaceId, name: s.name } },
          update: { position, kind: s.kind },
          create: { workspaceId, name: s.name, position, kind: s.kind },
        });
      }
    });
  }

  list(workspaceId: string, q: { stage?: string; contactId?: string; limit?: number }) {
    return this.d.db.lead.findMany({
      where: { workspaceId, ...(q.stage ? { stage: { name: q.stage } } : {}), ...(q.contactId ? { contactId: q.contactId } : {}) },
      include: { stage: true, contact: { select: { id: true, name: true, phone: true, email: true } } },
      orderBy: { updatedAt: "desc" },
      take: Math.min(q.limit ?? 100, 500),
    });
  }

  async get(workspaceId: string, id: string) {
    const lead = await this.d.db.lead.findFirst({ where: { id, workspaceId }, include: { stage: true } });
    if (!lead) throw notFound("Lead");
    return lead;
  }

  async create(workspaceId: string, input: LeadInput, actor: Actor) {
    const contact = await this.d.db.contact.findFirst({ where: { id: input.contactId, workspaceId }, select: { id: true } });
    if (!contact) throw notFound("Contacto");
    const stage = await this.resolveStage(workspaceId, input.stage);
    const lead = await this.d.db.lead.create({
      data: {
        workspaceId,
        contactId: input.contactId,
        stageId: stage.id,
        title: input.title,
        value: input.value ?? null,
        currency: input.currency ?? "EUR",
        source: input.source ?? null,
        notes: input.notes ?? null,
      },
      include: { stage: true },
    });
    await this.changed(workspaceId, lead.id, "lead.created", actor, { stage: stage.name });
    return lead;
  }

  async update(workspaceId: string, id: string, patch: LeadPatch, actor: Actor) {
    const current = await this.get(workspaceId, id);
    const stage = patch.stage ? await this.resolveStage(workspaceId, patch.stage) : null;
    const lead = await this.d.db.lead.update({
      where: { id: current.id },
      data: {
        title: patch.title,
        value: patch.value,
        currency: patch.currency,
        source: patch.source,
        notes: patch.notes,
        ...(stage ? { stageId: stage.id } : {}),
      },
      include: { stage: true },
    });
    const moved = stage && stage.id !== current.stageId;
    await this.changed(
      workspaceId,
      id,
      moved ? "lead.stage_changed" : "lead.updated",
      actor,
      moved ? { from: current.stage.name, to: stage.name } : { fields: Object.keys(patch) },
    );
    return lead;
  }

  /** Lead abierto más reciente del contacto o uno nuevo (lo usa la tool del agente). */
  async upsertForContact(workspaceId: string, contactId: string, input: Omit<LeadInput, "contactId">, actor: Actor) {
    const open = await this.d.db.lead.findFirst({ where: { workspaceId, contactId, stage: { kind: "OPEN" } }, orderBy: { updatedAt: "desc" } });
    return open ? this.update(workspaceId, open.id, input, actor) : this.create(workspaceId, { ...input, contactId }, actor);
  }

  async markSynced(workspaceId: string, id: string, system: string, externalId: string | null): Promise<void> {
    const lead = await this.get(workspaceId, id);
    const externalIds = { ...(lead.externalIds as Record<string, string>), ...(externalId ? { [system]: externalId } : {}) };
    await this.d.db.lead.update({ where: { id }, data: { externalIds, syncedAt: new Date() } });
  }

  private async resolveStage(workspaceId: string, name?: string) {
    const stages = await this.stages(workspaceId);
    const stage = name ? stages.find((s) => s.name.toLowerCase() === name.toLowerCase()) : stages[0];
    if (!stage) throw invalid("unknown_stage", `Etapa desconocida: ${name}. Etapas: ${stages.map((s) => s.name).join(", ")}`);
    return stage;
  }

  private async changed(workspaceId: string, leadId: string, type: string, actor: Actor, data: Prisma.InputJsonObject): Promise<void> {
    await audit(this.d.db, { workspaceId, actor, action: type, target: `lead:${leadId}`, data });
    await this.d.bus.publish({ workspaceId, type, subject: `lead:${leadId}`, data });
    const ws = await this.d.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    if ((ws.settings as { crmSync?: unknown }).crmSync) {
      await this.d.queue.send(JOBS.crmSync, { workspaceId, leadId }, { startAfter: 5 });
    }
  }
}
