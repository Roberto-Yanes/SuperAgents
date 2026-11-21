import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { actorFrom } from "../../auth/scopes.js";
import { publicConnection } from "../../../domain/connections/service.js";
import { CONNECTION_KIND_NAMES } from "../../../domain/connections/kinds.js";
import { IdParams } from "../schemas.js";
import { invalid } from "../../../shared/errors.js";
import { JOBS } from "../../../execution/queue/jobs.js";

const ConnectionOut = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  name: z.string(),
  config: z.unknown(),
  hasSecret: z.boolean(),
  status: z.enum(["PENDING", "OK", "ERROR", "DISABLED"]),
  lastError: z.string().nullable(),
  hints: z.record(z.string(), z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ConnectionCreate = z.object({
  kind: z.enum(CONNECTION_KIND_NAMES),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "minúsculas, números y guiones (se usa en 'conexión:modelo')"),
  config: z.record(z.string(), z.unknown()).default({}),
  secret: z.record(z.string(), z.unknown()).default({}).describe("Se cifra y nunca se devuelve"),
});

const ConnectionPatch = z.object({
  name: ConnectionCreate.shape.name.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["DISABLED", "PENDING"]).optional(),
});

const TestOut = z.object({ ok: z.boolean(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() });

export type ConnectionDeps = Pick<AppContext, "connections" | "queue" | "composio"> & { publicUrl: string };

export const connectionRoutes: FastifyPluginAsyncZod<{ deps: ConnectionDeps }> = async (app, { deps }) => {
  const out = (c: Parameters<typeof publicConnection>[0]) => publicConnection(c, deps.publicUrl);

  app.get(
    "/v1/connections",
    { preHandler: requireScopes("connections:read"), schema: { tags: ["connections"], response: { 200: z.object({ data: z.array(ConnectionOut) }) } } },
    async (req) => {
      return { data: (await deps.connections.list(principalOf(req).workspaceId)).map(out) };
    },
  );

  app.get(
    "/v1/connections/:id",
    { preHandler: requireScopes("connections:read"), schema: { tags: ["connections"], params: IdParams, response: { 200: ConnectionOut } } },
    async (req) => {
      return out(await deps.connections.get(principalOf(req).workspaceId, req.params.id));
    },
  );

  app.post(
    "/v1/connections",
    { preHandler: requireScopes("connections:write"), schema: { tags: ["connections"], body: ConnectionCreate, response: { 201: ConnectionOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const conn = await deps.connections.create(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send(out(conn));
    },
  );

  app.patch(
    "/v1/connections/:id",
    {
      preHandler: requireScopes("connections:write"),
      schema: { tags: ["connections"], params: IdParams, body: ConnectionPatch, response: { 200: ConnectionOut } },
    },
    async (req) => {
      const p = principalOf(req);
      const conn = await deps.connections.update(p.workspaceId, req.params.id, req.body, actorFrom(p));
      if (conn.kind === "composio") deps.composio.invalidate(p.workspaceId);
      return out(conn);
    },
  );

  app.post(
    "/v1/connections/:id/test",
    { preHandler: requireScopes("connections:write"), schema: { tags: ["connections"], params: IdParams, response: { 200: TestOut } } },
    async (req) => {
      const p = principalOf(req);
      return deps.connections.test(p.workspaceId, req.params.id, actorFrom(p));
    },
  );

  /** Sesiones con estado (WhatsApp por Baileys): el worker dueño de las sesiones ejecuta la acción. El QR llega por WS (subject connection:<id>). */
  app.post(
    "/v1/connections/:id/session",
    {
      preHandler: requireScopes("connections:write"),
      schema: {
        tags: ["connections"],
        params: IdParams,
        body: z.object({ action: z.enum(["start", "stop", "logout"]) }),
        response: { 202: z.object({ queued: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const conn = await deps.connections.get(p.workspaceId, req.params.id);
      if (conn.kind !== "channel.whatsapp_baileys") throw invalid("session_not_supported", "Solo las conexiones channel.whatsapp_baileys tienen sesión");
      await deps.queue.send(JOBS.channelSession, { workspaceId: p.workspaceId, connectionId: conn.id, action: req.body.action });
      return reply.code(202).send({ queued: true as const });
    },
  );
};
