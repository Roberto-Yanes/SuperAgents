import { z } from "zod";
import type { AgendaService } from "../../../domain/agenda/service.js";
import { systemActor } from "../../../data/audit.js";
import { defineTool, type ToolDef } from "../types.js";

/** Huecos y reservas. El cálculo del hueco lo hace AgendaService, nunca el modelo. */
export function agendaTools(agenda: AgendaService): ToolDef[] {
  const slots = defineTool({
    name: "agenda.slots",
    description: "Lista huecos libres de la agenda entre dos fechas ISO.",
    input: z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
      calendarId: z.string().uuid().optional(),
    }),
    scope: "agenda:read",
    risk: "read",
    exposure: "external",
    approval: "NEVER",
    async execute(input, ctx) {
      const calendarId = input.calendarId ?? (await agenda.defaultCalendar(ctx.workspaceId)).id;
      const found = await agenda.slots(ctx.workspaceId, calendarId, { from: new Date(input.from), to: new Date(input.to) }, { limit: 8 });
      return { ok: true, calendarId, slots: found.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
    },
  });

  const book = defineTool({
    name: "agenda.book",
    description: "Reserva un hueco. startsAt tiene que ser uno de los devueltos por agenda.slots.",
    input: z.object({
      startsAt: z.string().datetime(),
      title: z.string().min(1).max(200),
      calendarId: z.string().uuid().optional(),
      durationMinutes: z.number().int().min(5).max(480).optional(),
    }),
    scope: "agenda:write",
    risk: "write",
    exposure: "external",
    approval: "ASK_OWNER",
    preview: (i) => `Reservar «${i.title}» el ${i.startsAt}`,
    async execute(input, ctx) {
      const calendarId = input.calendarId ?? (await agenda.defaultCalendar(ctx.workspaceId)).id;
      const appt = await agenda.book(
        ctx.workspaceId,
        {
          calendarId,
          startsAt: new Date(input.startsAt),
          title: input.title,
          ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
          ...(ctx.contactId ? { contactId: ctx.contactId } : {}),
          ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        },
        systemActor,
      );
      return { ok: true, appointmentId: appt.id, startsAt: appt.startsAt.toISOString() };
    },
  });

  return [slots, book] as ToolDef[];
}
