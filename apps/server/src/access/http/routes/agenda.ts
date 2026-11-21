import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { CalendarInput } from "../../../domain/agenda/service.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { Id, IdParams, iso } from "../schemas.js";

export type AgendaDeps = Pick<AppContext, "agenda">;

const CalendarOut = z.object({ id: Id, name: z.string(), timezone: z.string(), slotMinutes: z.number().int(), active: z.boolean() });

export const agendaRoutes: FastifyPluginAsyncZod<{ deps: AgendaDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/calendars",
    { preHandler: requireScopes("agenda:read"), schema: { tags: ["agenda"], response: { 200: z.object({ data: z.array(CalendarOut) }) } } },
    async (req) => {
      const rows = await deps.agenda.listCalendars(principalOf(req).workspaceId);
      return { data: rows.map((c) => ({ id: c.id, name: c.name, timezone: c.timezone, slotMinutes: c.slotMinutes, active: c.active })) };
    },
  );

  app.post(
    "/v1/calendars",
    { preHandler: requireScopes("agenda:write"), schema: { tags: ["agenda"], body: CalendarInput, response: { 201: CalendarOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const c = await deps.agenda.createCalendar(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send({ id: c.id, name: c.name, timezone: c.timezone, slotMinutes: c.slotMinutes, active: c.active });
    },
  );

  app.get(
    "/v1/calendars/:id/slots",
    {
      preHandler: requireScopes("agenda:read"),
      schema: {
        tags: ["agenda"],
        params: IdParams,
        querystring: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
        response: { 200: z.object({ data: z.array(z.object({ startsAt: z.string(), endsAt: z.string() })) }) },
      },
    },
    async (req) => {
      const slots = await deps.agenda.slots(principalOf(req).workspaceId, req.params.id, { from: new Date(req.query.from), to: new Date(req.query.to) });
      return { data: slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
    },
  );

  app.post(
    "/v1/calendars/:id/appointments",
    {
      preHandler: requireScopes("agenda:write"),
      schema: {
        tags: ["agenda"],
        params: IdParams,
        body: z.object({
          startsAt: z.string().datetime(),
          title: z.string().min(1).max(200),
          contactId: Id.optional(),
          conversationId: Id.optional(),
          durationMinutes: z.number().int().optional(),
        }),
        response: { 201: z.object({ id: Id, startsAt: z.string(), endsAt: z.string(), title: z.string() }) },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const appt = await deps.agenda.book(
        p.workspaceId,
        {
          calendarId: req.params.id,
          startsAt: new Date(req.body.startsAt),
          title: req.body.title,
          ...(req.body.contactId ? { contactId: req.body.contactId } : {}),
          ...(req.body.conversationId ? { conversationId: req.body.conversationId } : {}),
          ...(req.body.durationMinutes ? { durationMinutes: req.body.durationMinutes } : {}),
        },
        actorFrom(p),
      );
      return reply.code(201).send({ id: appt.id, startsAt: iso(appt.startsAt)!, endsAt: iso(appt.endsAt)!, title: appt.title });
    },
  );

  app.post(
    "/v1/appointments/:id/cancel",
    { preHandler: requireScopes("agenda:write"), schema: { tags: ["agenda"], params: IdParams, response: { 200: z.object({ id: Id, status: z.string() }) } } },
    async (req) => {
      const p = principalOf(req);
      const appt = await deps.agenda.cancel(p.workspaceId, req.params.id, actorFrom(p));
      return { id: appt.id, status: appt.status };
    },
  );
};
