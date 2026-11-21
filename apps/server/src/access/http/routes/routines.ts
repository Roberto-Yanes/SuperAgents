import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { RoutineInput } from "../../../domain/routines/service.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { Id, IdParams } from "../schemas.js";

export type RoutineDeps = Pick<AppContext, "routines">;

const RoutineOut = z.object({ id: Id, name: z.string(), cron: z.string(), timezone: z.string(), enabled: z.boolean(), agentId: Id });

export const routineRoutes: FastifyPluginAsyncZod<{ deps: RoutineDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/routines",
    { preHandler: requireScopes("routines:read"), schema: { tags: ["routines"], response: { 200: z.object({ data: z.array(RoutineOut) }) } } },
    async (req) => {
      const rows = await deps.routines.list(principalOf(req).workspaceId);
      return { data: rows.map((r) => ({ id: r.id, name: r.name, cron: r.cron, timezone: r.timezone, enabled: r.enabled, agentId: r.agentId })) };
    },
  );

  app.post(
    "/v1/routines",
    { preHandler: requireScopes("routines:write"), schema: { tags: ["routines"], body: RoutineInput, response: { 201: RoutineOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const r = await deps.routines.create(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send({ id: r.id, name: r.name, cron: r.cron, timezone: r.timezone, enabled: r.enabled, agentId: r.agentId });
    },
  );

  app.post(
    "/v1/routines/:id/fire",
    { preHandler: requireScopes("routines:write"), schema: { tags: ["routines"], params: IdParams, response: { 202: z.object({ runId: Id.nullable() }) } } },
    async (req, reply) => {
      const fired = await deps.routines.fire(principalOf(req).workspaceId, req.params.id);
      return reply.code(202).send({ runId: fired?.runId ?? null });
    },
  );
};
