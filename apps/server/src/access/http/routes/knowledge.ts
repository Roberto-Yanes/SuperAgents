import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import type { KnowledgeDocument } from "../../../data/generated/prisma/client.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { IdParams } from "../schemas.js";

export type KnowledgeDeps = Pick<AppContext, "knowledge">;

const DocOut = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  mimeType: z.string(),
  fileId: z.string().nullable(),
  status: z.string(),
  chunkCount: z.number().int(),
  createdAt: z.string(),
});
const out = (d: KnowledgeDocument) => ({
  id: d.id,
  title: d.title,
  source: d.source,
  mimeType: d.mimeType,
  fileId: d.fileId,
  status: d.status,
  chunkCount: d.chunkCount,
  createdAt: d.createdAt.toISOString(),
});

/** Base de conocimiento (RAG, ADR 003 capa 1). Documento desde texto o desde un archivo de texto ya subido. */
export const knowledgeRoutes: FastifyPluginAsyncZod<{ deps: KnowledgeDeps }> = async (app, { deps }) => {
  app.post(
    "/v1/knowledge/documents",
    {
      bodyLimit: 4 * 1024 * 1024,
      preHandler: requireScopes("knowledge:write"),
      schema: {
        tags: ["knowledge"],
        body: z
          .object({ title: z.string().min(1).max(200), text: z.string().min(1).max(2_000_000).optional(), fileId: z.uuid().optional() })
          .refine((b) => Boolean(b.text) !== Boolean(b.fileId), {
            message: "Envía text o fileId (uno de los dos)",
          }),
        response: { 201: DocOut },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      return reply.code(201).send(out(await deps.knowledge.create(p.workspaceId, req.body, actorFrom(p))));
    },
  );

  app.get(
    "/v1/knowledge/documents",
    { preHandler: requireScopes("knowledge:read"), schema: { tags: ["knowledge"], response: { 200: z.object({ data: z.array(DocOut) }) } } },
    async (req) => ({
      data: (await deps.knowledge.list(principalOf(req).workspaceId)).map(out),
    }),
  );

  app.get(
    "/v1/knowledge/documents/:id",
    { preHandler: requireScopes("knowledge:read"), schema: { tags: ["knowledge"], params: IdParams, response: { 200: DocOut } } },
    async (req) => out(await deps.knowledge.get(principalOf(req).workspaceId, req.params.id)),
  );

  app.delete(
    "/v1/knowledge/documents/:id",
    { preHandler: requireScopes("knowledge:write"), schema: { tags: ["knowledge"], params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const p = principalOf(req);
      await deps.knowledge.remove(p.workspaceId, req.params.id, actorFrom(p));
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/v1/knowledge/search",
    {
      preHandler: requireScopes("knowledge:read"),
      schema: {
        tags: ["knowledge"],
        body: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional() }),
        response: {
          200: z.object({
            data: z.array(z.object({ chunkId: z.string(), documentId: z.string(), title: z.string(), content: z.string(), score: z.number() })),
          }),
        },
      },
    },
    async (req) => ({ data: await deps.knowledge.search(principalOf(req).workspaceId, req.body.query, req.body.limit ?? 5) }),
  );
};
