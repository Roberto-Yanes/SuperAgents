import { z } from "zod";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import { enqueueRun, JOBS, type JobQueue } from "../../execution/queue/jobs.js";
import { audit, type Actor } from "../../data/audit.js";
import { conflict, notFound } from "../../shared/errors.js";
import type { ConversationService } from "../conversations/service.js";

export const SequenceStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), delayMinutes: z.number().int().min(0).max(525_600), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("agent"), delayMinutes: z.number().int().min(0).max(525_600), instruction: z.string().min(1).max(4000) }),
]);
export type SequenceStep = z.infer<typeof SequenceStep>;

export const SequenceInput = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(SequenceStep).min(1).max(20),
  stopOnReply: z.boolean().default(true),
  active: z.boolean().default(true),
});
export type SequenceInput = z.infer<typeof SequenceInput>;

/**
 * Secuencias de seguimiento: pasos con espera que envían un mensaje fijo o encargan al agente redactarlo.
 * Se detienen solas si el contacto responde (stopOnReply), si una persona toma la conversación o si se cierra.
 */
export class SequenceService {
  constructor(private readonly d: { db: Db; queue: JobQueue; conversations: ConversationService; clock?: () => Date }) {}

  private now(): Date {
    return this.d.clock?.() ?? new Date();
  }

  list(workspaceId: string) {
    return this.d.db.sequence.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  }

  async get(workspaceId: string, id: string) {
    const s = await this.d.db.sequence.findFirst({ where: { id, workspaceId } });
    if (!s) throw notFound("Secuencia");
    return s;
  }

  async findByName(workspaceId: string, name: string) {
    return this.d.db.sequence.findFirst({ where: { workspaceId, name: { equals: name, mode: "insensitive" }, active: true } });
  }

  async create(workspaceId: string, input: SequenceInput, actor: Actor) {
    const s = await this.d.db.sequence.create({
      data: { workspaceId, name: input.name, steps: input.steps as Prisma.InputJsonValue, stopOnReply: input.stopOnReply, active: input.active },
    });
    await audit(this.d.db, { workspaceId, actor, action: "sequence.created", target: `sequence:${s.id}` });
    return s;
  }

  async update(workspaceId: string, id: string, input: Partial<SequenceInput>, actor: Actor) {
    await this.get(workspaceId, id);
    const s = await this.d.db.sequence.update({ where: { id }, data: { ...input, steps: input.steps as Prisma.InputJsonValue | undefined } });
    await audit(this.d.db, { workspaceId, actor, action: "sequence.updated", target: `sequence:${id}` });
    return s;
  }

  async enroll(workspaceId: string, sequenceId: string, conversationId: string, actor: Actor) {
    const seq = await this.get(workspaceId, sequenceId);
    if (!seq.active) throw conflict("sequence_inactive", "La secuencia está desactivada");
    const conv = await this.d.conversations.get(workspaceId, conversationId);
    const steps = seq.steps as SequenceStep[];
    const nextRunAt = new Date(this.now().getTime() + steps[0]!.delayMinutes * 60_000);
    let enrollment;
    try {
      enrollment = await this.d.db.sequenceEnrollment.create({
        data: { workspaceId, sequenceId, conversationId, contactId: conv.contactId, nextRunAt },
      });
    } catch (err) {
      if (String((err as Error).message).includes("sequence_enrollment_one_active") || (err as { code?: string }).code === "P2002") {
        throw conflict("already_enrolled", "La conversación ya está en esta secuencia");
      }
      throw err;
    }
    await this.d.queue.send(JOBS.sequenceStep, { workspaceId, enrollmentId: enrollment.id, step: 0 }, { startAfter: nextRunAt });
    await audit(this.d.db, { workspaceId, actor, action: "sequence.enrolled", target: `enrollment:${enrollment.id}`, data: { sequenceId, conversationId } });
    return enrollment;
  }

  async stop(workspaceId: string, enrollmentId: string, actor: Actor) {
    const e = await this.d.db.sequenceEnrollment.findFirst({ where: { id: enrollmentId, workspaceId } });
    if (!e) throw notFound("Inscripción");
    await audit(this.d.db, { workspaceId, actor, action: "sequence.stopped", target: `enrollment:${enrollmentId}` });
    return this.d.db.sequenceEnrollment.update({ where: { id: enrollmentId }, data: { status: "STOPPED", stoppedReason: "manual", nextRunAt: null } });
  }

  enrollments(workspaceId: string, q: { conversationId?: string; status?: "ACTIVE" | "COMPLETED" | "STOPPED" | "FAILED" }) {
    return this.d.db.sequenceEnrollment.findMany({ where: { workspaceId, ...q }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  /**
   * Ejecuta el paso `step` (job sequence.step). Idempotente: si la inscripción ya no está activa o ya avanzó, no hace nada.
   * Devuelve el run creado cuando el paso es de tipo "agent" (para que el llamador lo encole).
   */
  async runStep(workspaceId: string, enrollmentId: string, step: number): Promise<{ runId?: string } | null> {
    const e = await this.d.db.sequenceEnrollment.findFirst({
      where: { id: enrollmentId, workspaceId },
      include: { sequence: true, conversation: { include: { agent: true, contact: true } } },
    });
    if (!e || e.status !== "ACTIVE" || e.currentStep !== step) return null;
    const conv = e.conversation;
    if (!e.sequence.active || conv.status !== "OPEN" || conv.takenOverBy) {
      await this.d.db.sequenceEnrollment.update({ where: { id: e.id }, data: { status: "STOPPED", stoppedReason: "not_applicable", nextRunAt: null } });
      return null;
    }
    const steps = e.sequence.steps as SequenceStep[];
    const current = steps[step];
    if (!current) {
      await this.d.db.sequenceEnrollment.update({ where: { id: e.id }, data: { status: "COMPLETED", nextRunAt: null } });
      return null;
    }

    let runId: string | undefined;
    if (current.kind === "message") {
      await this.d.conversations.sendOutbound(conv, renderTemplate(current.text, { contact: { name: conv.contact?.name ?? "" } }), "SYSTEM", {
        sequenceId: e.sequenceId,
        step,
      });
    } else {
      const run = await this.d.db.run.create({
        data: {
          workspaceId,
          agentId: conv.agentId,
          agentVersion: conv.agent.version,
          conversationId: conv.id,
          trigger: "sequence",
          input: { instruction: current.instruction, sequenceId: e.sequenceId, step },
        },
      });
      runId = run.id;
      await enqueueRun(this.d.queue, run, "execute");
    }

    const nextIndex = step + 1;
    const next = steps[nextIndex];
    if (next) {
      const nextRunAt = new Date(this.now().getTime() + next.delayMinutes * 60_000);
      await this.d.db.sequenceEnrollment.update({ where: { id: e.id }, data: { currentStep: nextIndex, nextRunAt } });
      await this.d.queue.send(JOBS.sequenceStep, { workspaceId, enrollmentId: e.id, step: nextIndex }, { startAfter: nextRunAt });
    } else {
      await this.d.db.sequenceEnrollment.update({ where: { id: e.id }, data: { currentStep: nextIndex, status: "COMPLETED", nextRunAt: null } });
    }
    return { ...(runId ? { runId } : {}) };
  }
}

/** Sustituye {{ruta.al.valor}} por su valor (texto). Variables ausentes → vacío. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const value = path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), vars);
    return value === undefined || value === null ? "" : String(value);
  });
}
