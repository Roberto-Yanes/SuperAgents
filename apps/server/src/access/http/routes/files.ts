import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import type { StoredFile } from "../../../data/generated/prisma/client.js";
import { MAX_FILE_BYTES } from "../../../domain/files/service.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { IdParams } from "../schemas.js";

export type FileDeps = Pick<AppContext, "files">;

const FileOut = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.number().int(), sha256: z.string(), createdAt: z.string() });
const out = (f: StoredFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, sha256: f.sha256, createdAt: f.createdAt.toISOString() });

/**
 * Archivos cifrados del workspace. Subida: POST /v1/files?name=<nombre> con el contenido crudo en el cuerpo y su
 * Content-Type real (hasta 10 MB). Se guardan cifrados (AES-256-GCM, AAD por archivo) en el volumen del servidor.
 */
export const fileRoutes: FastifyPluginAsyncZod<{ deps: FileDeps }> = async (app, { deps }) => {
  // En este ámbito el cuerpo llega crudo, sea cual sea su tipo (también JSON).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES }, (_req, body, done) => done(null, body));

  app.post(
    "/v1/files",
    {
      bodyLimit: MAX_FILE_BYTES,
      preHandler: requireScopes("files:write"),
      schema: { tags: ["files"], querystring: z.object({ name: z.string().min(1).max(200) }), response: { 201: FileOut } },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const mimeType = String(req.headers["content-type"] ?? "application/octet-stream")
        .split(";")[0]!
        .trim();
      const file = await deps.files.upload(p.workspaceId, { name: req.query.name, mimeType, data }, actorFrom(p));
      return reply.code(201).send(out(file));
    },
  );

  app.get(
    "/v1/files",
    {
      preHandler: requireScopes("files:read"),
      schema: {
        tags: ["files"],
        querystring: z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
        response: { 200: z.object({ data: z.array(FileOut), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const r = await deps.files.list(principalOf(req).workspaceId, req.query);
      return { data: r.data.map(out), nextCursor: r.nextCursor };
    },
  );

  app.get(
    "/v1/files/:id",
    { preHandler: requireScopes("files:read"), schema: { tags: ["files"], params: IdParams, response: { 200: FileOut } } },
    async (req) => out(await deps.files.get(principalOf(req).workspaceId, req.params.id)),
  );

  app.get("/v1/files/:id/content", { preHandler: requireScopes("files:read"), schema: { tags: ["files"], params: IdParams } }, async (req, reply) => {
    const { file, data } = await deps.files.read(principalOf(req).workspaceId, req.params.id);
    return reply
      .header("content-type", file.mimeType)
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header("x-content-type-options", "nosniff")
      .send(data);
  });

  app.delete(
    "/v1/files/:id",
    { preHandler: requireScopes("files:write"), schema: { tags: ["files"], params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const p = principalOf(req);
      await deps.files.remove(p.workspaceId, req.params.id, actorFrom(p));
      return reply.code(204).send(null);
    },
  );
};
