import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { actorFrom } from "../../auth/scopes.js";
import { ApiKeyCreate, ApiKeyCreated, ApiKeyOut, IdParams, iso } from "../schemas.js";

export type ApiKeyDeps = Pick<AppContext, "apiKeys">;

type KeyRow = Awaited<ReturnType<AppContext["apiKeys"]["list"]>>[number];
const toOut = (k: KeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  lastUsedAt: iso(k.lastUsedAt),
  revokedAt: iso(k.revokedAt),
  createdAt: iso(k.createdAt)!,
});

export const apiKeyRoutes: FastifyPluginAsyncZod<{ deps: ApiKeyDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/api-keys",
    { preHandler: requireScopes("api_keys:write"), schema: { tags: ["api-keys"], response: { 200: z.object({ data: z.array(ApiKeyOut) }) } } },
    async (req) => {
      return { data: (await deps.apiKeys.list(principalOf(req).workspaceId)).map(toOut) };
    },
  );

  app.post(
    "/v1/api-keys",
    { preHandler: requireScopes("api_keys:write"), schema: { tags: ["api-keys"], body: ApiKeyCreate, response: { 201: ApiKeyCreated } } },
    async (req, reply) => {
      const p = principalOf(req);
      const { key, token } = await deps.apiKeys.issueFor(
        p,
        { name: req.body.name, scopes: req.body.scopes, ...(req.body.expiresAt ? { expiresAt: new Date(req.body.expiresAt) } : {}) },
        actorFrom(p),
      );
      return reply.code(201).send({ ...toOut(key), token });
    },
  );

  app.delete(
    "/v1/api-keys/:id",
    { preHandler: requireScopes("api_keys:write"), schema: { tags: ["api-keys"], params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const p = principalOf(req);
      await deps.apiKeys.revoke(p.workspaceId, req.params.id, actorFrom(p));
      return reply.code(204).send(null);
    },
  );
};
