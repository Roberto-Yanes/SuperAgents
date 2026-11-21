import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { AgentInput, AgentPatch } from "../../../domain/agents/service.js";
import { actorFrom } from "../../auth/scopes.js";
import { AgentOut, IdParams, iso } from "../schemas.js";

export type AgentDeps = Pick<AppContext, "agents">;
type AgentRow = Awaited<ReturnType<AppContext["agents"]["get"]>>;

const toOut = (a: AgentRow): z.infer<typeof AgentOut> => {
  const cfg = a.toolConfig as { tools?: string[]; approvals?: Record<string, "NEVER" | "ASK_OWNER" | "ALWAYS">; external?: string[] };
  return {
    id: a.id,
    name: a.name,
    instructions: a.instructions,
    model: a.model,
    status: a.status,
    version: a.version,
    tools: cfg.tools ?? [],
    approvals: cfg.approvals ?? {},
    external: cfg.external ?? [],
    createdAt: iso(a.createdAt)!,
    updatedAt: iso(a.updatedAt)!,
  };
};

export const agentRoutes: FastifyPluginAsyncZod<{ deps: AgentDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/agents",
    { preHandler: requireScopes("agents:read"), schema: { tags: ["agents"], response: { 200: z.object({ data: z.array(AgentOut) }) } } },
    async (req) => {
      const p = principalOf(req);
      return { data: (await deps.agents.list(p.workspaceId)).map(toOut) };
    },
  );

  app.get(
    "/v1/agents/:id",
    { preHandler: requireScopes("agents:read"), schema: { tags: ["agents"], params: IdParams, response: { 200: AgentOut } } },
    async (req) => {
      return toOut(await deps.agents.get(principalOf(req).workspaceId, req.params.id));
    },
  );

  app.post(
    "/v1/agents",
    { preHandler: requireScopes("agents:write"), schema: { tags: ["agents"], body: AgentInput, response: { 201: AgentOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const agent = await deps.agents.create(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send(toOut(agent));
    },
  );

  app.patch(
    "/v1/agents/:id",
    { preHandler: requireScopes("agents:write"), schema: { tags: ["agents"], params: IdParams, body: AgentPatch, response: { 200: AgentOut } } },
    async (req) => {
      const p = principalOf(req);
      return toOut(await deps.agents.update(p.workspaceId, req.params.id, req.body, actorFrom(p)));
    },
  );
};
