import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";

export type TemplateDeps = Pick<AppContext, "templates">;

const TemplateSummary = z.object({
  id: z.string(),
  name: z.string(),
  sector: z.string(),
  description: z.string(),
  tools: z.array(z.string()),
  hasCalendar: z.boolean(),
  hasSequence: z.boolean(),
});

/** Plantillas por rubro: catálogo y aplicación (crea agente, embudo, calendario, secuencia y rutinas desactivadas). */
export const templateRoutes: FastifyPluginAsyncZod<{ deps: TemplateDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/templates",
    { preHandler: requireScopes("agents:read"), schema: { tags: ["templates"], response: { 200: z.object({ data: z.array(TemplateSummary) }) } } },
    async () => ({
      data: deps.templates.list(),
    }),
  );

  app.get(
    "/v1/templates/:id",
    {
      preHandler: requireScopes("agents:read"),
      schema: { tags: ["templates"], params: z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/) }), response: { 200: z.unknown() } },
    },
    async (req) => deps.templates.get(req.params.id),
  );

  app.post(
    "/v1/templates/:id/apply",
    {
      preHandler: requireScopes("templates:apply", "agents:write"),
      schema: {
        tags: ["templates"],
        params: z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/) }),
        body: z.object({
          model: z.string().min(3).max(200),
          agentName: z.string().min(1).max(120).optional(),
          calendar: z.boolean().optional(),
          pipeline: z.boolean().optional(),
          sequence: z.boolean().optional(),
          routines: z.boolean().optional(),
        }),
        response: {
          201: z.object({
            templateId: z.string(),
            agentId: z.string(),
            calendarId: z.string().nullable(),
            sequenceId: z.string().nullable(),
            routineIds: z.array(z.string()),
            pipelineApplied: z.boolean(),
            warnings: z.array(z.string()),
            checklist: z.array(z.string()),
          }),
        },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      return reply.code(201).send(await deps.templates.apply(p.workspaceId, req.params.id, req.body, actorFrom(p)));
    },
  );
};
