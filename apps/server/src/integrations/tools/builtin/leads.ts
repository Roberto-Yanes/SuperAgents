import { z } from "zod";
import type { LeadService } from "../../../domain/leads/service.js";
import { systemActor } from "../../../data/audit.js";
import { defineTool, type ToolDef } from "../types.js";

/** Alta y movimiento de leads del contacto de la conversación. */
export function leadTools(leads: LeadService): ToolDef[] {
  const create = defineTool({
    name: "lead.create",
    description: "Crea o actualiza el lead abierto del contacto actual.",
    input: z.object({
      title: z.string().min(1).max(200),
      stage: z.string().max(80).optional(),
      value: z.number().nonnegative().optional(),
    }),
    scope: "leads:write",
    risk: "write",
    exposure: "external",
    approval: "NEVER",
    async execute(input, ctx) {
      if (!ctx.contactId) return { ok: false, error: "No hay contacto asociado" };
      const lead = await leads.upsertForContact(
        ctx.workspaceId,
        ctx.contactId,
        { title: input.title, ...(input.stage ? { stage: input.stage } : {}), ...(input.value !== undefined ? { value: input.value } : {}) },
        systemActor,
      );
      return { ok: true, leadId: lead.id, stage: lead.stage.name };
    },
  });

  const move = defineTool({
    name: "lead.move",
    description: "Mueve un lead a otra etapa del embudo.",
    input: z.object({ leadId: z.string().uuid(), stage: z.string().min(1).max(80) }),
    scope: "leads:write",
    risk: "write",
    exposure: "internal",
    approval: "NEVER",
    async execute(input, ctx) {
      const lead = await leads.update(ctx.workspaceId, input.leadId, { stage: input.stage }, systemActor);
      return { ok: true, leadId: lead.id, stage: lead.stage.name };
    },
  });

  return [create, move] as ToolDef[];
}
