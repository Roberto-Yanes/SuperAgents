import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { LeadInput, LeadPatch } from "../../../domain/leads/service.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { Id, IdParams } from "../schemas.js";

export type LeadDeps = Pick<AppContext, "leads">;

const LeadOut = z.object({
  id: Id,
  title: z.string(),
  stage: z.string(),
  value: z.number().nullable(),
  currency: z.string(),
  contactId: Id,
});

export const leadRoutes: FastifyPluginAsyncZod<{ deps: LeadDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/leads",
    {
      preHandler: requireScopes("leads:read"),
      schema: {
        tags: ["leads"],
        querystring: z.object({ stage: z.string().optional(), contactId: Id.optional() }),
        response: { 200: z.object({ data: z.array(LeadOut) }) },
      },
    },
    async (req) => {
      const rows = await deps.leads.list(principalOf(req).workspaceId, req.query);
      return {
        data: rows.map((l) => ({
          id: l.id,
          title: l.title,
          stage: l.stage.name,
          value: l.value === null ? null : Number(l.value),
          currency: l.currency,
          contactId: l.contactId,
        })),
      };
    },
  );

  app.post(
    "/v1/leads",
    { preHandler: requireScopes("leads:write"), schema: { tags: ["leads"], body: LeadInput, response: { 201: LeadOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const l = await deps.leads.create(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send({
        id: l.id,
        title: l.title,
        stage: l.stage.name,
        value: l.value === null ? null : Number(l.value),
        currency: l.currency,
        contactId: l.contactId,
      });
    },
  );

  app.patch(
    "/v1/leads/:id",
    { preHandler: requireScopes("leads:write"), schema: { tags: ["leads"], params: IdParams, body: LeadPatch, response: { 200: LeadOut } } },
    async (req) => {
      const p = principalOf(req);
      const l = await deps.leads.update(p.workspaceId, req.params.id, req.body, actorFrom(p));
      return { id: l.id, title: l.title, stage: l.stage.name, value: l.value === null ? null : Number(l.value), currency: l.currency, contactId: l.contactId };
    },
  );
};
