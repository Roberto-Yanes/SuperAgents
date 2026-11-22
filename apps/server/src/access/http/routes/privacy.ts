import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { IdParams } from "../schemas.js";

export type PrivacyDeps = Pick<AppContext, "privacy">;

/** Derechos RGPD de un contacto y retención del workspace (ADR 005). Solo OWNER/ADMIN (privacy:admin, workspace:admin). */
export const privacyRoutes: FastifyPluginAsyncZod<{ deps: PrivacyDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/contacts/:id/export",
    { preHandler: requireScopes("privacy:admin"), schema: { tags: ["privacy"], params: IdParams, response: { 200: z.record(z.string(), z.unknown()) } } },
    async (req, reply) => {
      const p = principalOf(req);
      const data = await deps.privacy.export(p.workspaceId, req.params.id, actorFrom(p));
      return reply.header("content-disposition", `attachment; filename="contacto-${req.params.id}.json"`).send(data);
    },
  );

  app.post(
    "/v1/contacts/:id/erase",
    {
      preHandler: requireScopes("privacy:admin"),
      schema: {
        tags: ["privacy"],
        params: IdParams,
        body: z.object({ confirm: z.literal(true) }),
        response: { 200: z.object({ erased: z.literal(true), counts: z.record(z.string(), z.number()) }) },
      },
    },
    async (req) => {
      const p = principalOf(req);
      return { erased: true as const, counts: await deps.privacy.erase(p.workspaceId, req.params.id, actorFrom(p)) };
    },
  );

  app.put(
    "/v1/workspace/retention",
    {
      preHandler: requireScopes("workspace:admin"),
      schema: {
        tags: ["workspace"],
        body: z.object({ contentDays: z.number().int().min(1).max(365).optional(), auditDays: z.number().int().min(30).max(365).optional() }).strict(),
        response: { 200: z.object({ contentDays: z.number(), auditDays: z.number() }) },
      },
    },
    async (req) => {
      const p = principalOf(req);
      return deps.privacy.setRetention(p.workspaceId, req.body, actorFrom(p));
    },
  );
};
