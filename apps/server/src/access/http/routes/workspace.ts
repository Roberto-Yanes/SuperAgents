import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { LLM_PROVIDERS } from "../../../domain/connections/llm-residency.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { TaskLimitsIn } from "../schemas.js";

export type WorkspaceDeps = Pick<AppContext, "workspacePolicies">;

const Decision = z.enum(["direct", "approval"]);
const RiskPolicyIn = z
  .object({
    read: Decision.optional(),
    write: z
      .object({ internal: Decision.optional(), external: z.literal("approval").optional() })
      .strict()
      .optional(),
    send: Decision.optional(),
    money: Decision.optional(),
    delete: z.literal("approval").optional(),
  })
  .strict();
const LlmPolicyIn = z.object({ allowed: z.array(z.enum(LLM_PROVIDERS)).optional(), hosts: z.array(z.string().min(1).max(253)).max(50).optional() }).strict();
const PoliciesOut = z.object({ riskPolicy: z.unknown(), llmPolicy: z.unknown(), taskLimits: z.unknown() });

/**
 * Políticas del workspace (E4, E7, E3). Solo endurecen lo que manda la plataforma.
 * Bajar send o money a directo exige un usuario OWNER (no una API key) y queda auditado.
 */
export const workspaceRoutes: FastifyPluginAsyncZod<{ deps: WorkspaceDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/workspace/policies",
    { preHandler: requireScopes("workspace:admin"), schema: { tags: ["workspace"], response: { 200: PoliciesOut } } },
    async (req) => deps.workspacePolicies.get(principalOf(req).workspaceId),
  );

  app.put(
    "/v1/workspace/risk-policy",
    { preHandler: requireScopes("workspace:admin"), schema: { tags: ["workspace"], body: RiskPolicyIn, response: { 200: RiskPolicyIn } } },
    async (req) => {
      const p = principalOf(req);
      return deps.workspacePolicies.setRiskPolicy(p.workspaceId, req.body, actorFrom(p), p.role);
    },
  );

  app.put(
    "/v1/workspace/llm-policy",
    { preHandler: requireScopes("workspace:admin"), schema: { tags: ["workspace"], body: LlmPolicyIn, response: { 200: LlmPolicyIn } } },
    async (req) => {
      const p = principalOf(req);
      return deps.workspacePolicies.setLlmPolicy(p.workspaceId, req.body, actorFrom(p));
    },
  );

  app.put(
    "/v1/workspace/task-limits",
    { preHandler: requireScopes("workspace:admin"), schema: { tags: ["workspace"], body: TaskLimitsIn, response: { 200: TaskLimitsIn } } },
    async (req) => {
      const p = principalOf(req);
      return deps.workspacePolicies.setTaskLimits(p.workspaceId, req.body, actorFrom(p));
    },
  );
};
