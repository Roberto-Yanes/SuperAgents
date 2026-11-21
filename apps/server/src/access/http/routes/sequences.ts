import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { SequenceInput } from "../../../domain/sequences/service.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { Id, IdParams } from "../schemas.js";

export type SequenceDeps = Pick<AppContext, "sequences">;

const SequenceOut = z.object({ id: Id, name: z.string(), active: z.boolean(), stopOnReply: z.boolean() });

export const sequenceRoutes: FastifyPluginAsyncZod<{ deps: SequenceDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/sequences",
    { preHandler: requireScopes("sequences:read"), schema: { tags: ["sequences"], response: { 200: z.object({ data: z.array(SequenceOut) }) } } },
    async (req) => {
      const rows = await deps.sequences.list(principalOf(req).workspaceId);
      return { data: rows.map((s) => ({ id: s.id, name: s.name, active: s.active, stopOnReply: s.stopOnReply })) };
    },
  );

  app.post(
    "/v1/sequences",
    { preHandler: requireScopes("sequences:write"), schema: { tags: ["sequences"], body: SequenceInput, response: { 201: SequenceOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const s = await deps.sequences.create(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send({ id: s.id, name: s.name, active: s.active, stopOnReply: s.stopOnReply });
    },
  );

  app.post(
    "/v1/sequences/:id/enroll",
    {
      preHandler: requireScopes("sequences:write"),
      schema: { tags: ["sequences"], params: IdParams, body: z.object({ conversationId: Id }), response: { 201: z.object({ id: Id, status: z.string() }) } },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const e = await deps.sequences.enroll(p.workspaceId, req.params.id, req.body.conversationId, actorFrom(p));
      return reply.code(201).send({ id: e.id, status: e.status });
    },
  );
};
