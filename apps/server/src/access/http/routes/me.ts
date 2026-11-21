import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { exposureOf } from "../../../integrations/tools/registry.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { parseSubject, subjectBelongsTo } from "../subjects.js";
import { HttpError } from "../errors.js";

export type MeDeps = Pick<AppContext, "db" | "tools" | "bus" | "runQueries" | "conversations" | "connections">;

/**
 * Rutas de contexto para la UI y las integraciones:
 * - GET /v1/me: quién soy, en qué workspace y con qué permisos (y mis otros workspaces si soy usuario).
 * - GET /v1/tools: catálogo de tools disponibles en el workspace (para configurar agentes).
 * - GET /v1/events: lectura paginada del bus por subject (alternativa a SSE/WS para clientes que hacen polling).
 */
export const meRoutes: FastifyPluginAsyncZod<{ deps: MeDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/me",
    {
      schema: {
        tags: ["system"],
        response: {
          200: z.object({
            kind: z.enum(["api_key", "user"]),
            actorId: z.string(),
            role: z.enum(["OWNER", "ADMIN", "OPERATOR"]).nullable(),
            scopes: z.array(z.string()),
            workspace: z.object({ id: z.string(), name: z.string(), slug: z.string(), timezone: z.string() }),
            user: z.object({ id: z.string(), email: z.string(), name: z.string() }).nullable(),
            memberships: z.array(z.object({ workspaceId: z.string(), name: z.string(), slug: z.string(), role: z.enum(["OWNER", "ADMIN", "OPERATOR"]) })),
          }),
        },
      },
    },
    async (req) => {
      const p = principalOf(req);
      const workspace = await deps.db.workspace.findUniqueOrThrow({
        where: { id: p.workspaceId },
        select: { id: true, name: true, slug: true, timezone: true },
      });
      const user = p.kind === "user" ? await deps.db.user.findUnique({ where: { id: p.actorId }, select: { id: true, email: true, name: true } }) : null;
      const memberships =
        p.kind === "user"
          ? await deps.db.membership.findMany({
              where: { userId: p.actorId },
              include: { workspace: { select: { name: true, slug: true } } },
              orderBy: { createdAt: "asc" },
            })
          : [];
      return {
        kind: p.kind,
        actorId: p.actorId,
        role: p.role ?? null,
        scopes: [...p.scopes].sort(),
        workspace,
        user,
        memberships: memberships.map((m) => ({ workspaceId: m.workspaceId, name: m.workspace.name, slug: m.workspace.slug, role: m.role })),
      };
    },
  );

  app.get(
    "/v1/tools",
    {
      preHandler: requireScopes("agents:read"),
      schema: {
        tags: ["agents"],
        response: {
          200: z.object({
            data: z.array(
              z.object({
                name: z.string(),
                description: z.string(),
                risk: z.enum(["read", "write", "send"]),
                approval: z.enum(["NEVER", "ASK_OWNER", "ALWAYS"]),
                exposure: z.enum(["internal", "external"]),
                scope: z.string(),
                requiresConnection: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const defs = await deps.tools.listForWorkspace(principalOf(req).workspaceId);
      return {
        data: defs.map((d) => ({
          name: d.name,
          description: d.description,
          risk: d.risk,
          approval: d.approval,
          exposure: exposureOf(d),
          scope: d.scope,
          requiresConnection: d.requiresConnection ?? null,
        })),
      };
    },
  );

  app.get(
    "/v1/events",
    {
      preHandler: requireScopes("events:read"),
      schema: {
        tags: ["realtime"],
        querystring: z.object({
          subject: z.string(),
          after: z.string().regex(/^\d+$/).default("0"),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: {
          200: z.object({
            data: z.array(z.object({ seq: z.string(), type: z.string(), subject: z.string(), data: z.unknown(), createdAt: z.string() })),
            nextAfter: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const p = principalOf(req);
      const s = parseSubject(req.query.subject);
      if (!s) throw new HttpError(400, "bad_subject", "subject debe ser run:<uuid>, conversation:<uuid> o connection:<uuid>");
      if (s.kind === "connection" && !p.scopes.has("connections:read")) throw new HttpError(403, "forbidden", "Falta connections:read");
      if (!(await subjectBelongsTo(deps, p.workspaceId, s.kind, s.id))) throw new HttpError(404, "not_found", "Recurso no encontrado");
      const events = await deps.bus.backlog(p.workspaceId, s.normalized, BigInt(req.query.after), req.query.limit);
      return {
        data: events.map((e) => ({ seq: e.seq, type: e.type, subject: e.subject, data: e.data, createdAt: e.createdAt })),
        nextAfter: events.at(-1)?.seq ?? req.query.after,
      };
    },
  );
};
