import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { actorFrom } from "../../auth/scopes.js";
import { ApprovalDecision, ApprovalOut, IdParams, iso } from "../schemas.js";

export type ApprovalDeps = Pick<AppContext, "approvals">;
type Row = Awaited<ReturnType<AppContext["approvals"]["get"]>>;
const toOut = (a: Row): z.infer<typeof ApprovalOut> => ({
  id: a.id,
  runId: a.runId,
  toolName: a.toolName,
  preview: a.preview,
  args: a.args,
  mode: a.mode,
  status: a.status,
  expiresAt: iso(a.expiresAt)!,
  decidedAt: iso(a.decidedAt),
  createdAt: iso(a.createdAt)!,
});

export const approvalRoutes: FastifyPluginAsyncZod<{ deps: ApprovalDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/approvals",
    {
      preHandler: requireScopes("approvals:read"),
      schema: {
        tags: ["approvals"],
        querystring: z.object({ status: ApprovalOut.shape.status.optional() }),
        response: { 200: z.object({ data: z.array(ApprovalOut) }) },
      },
    },
    async (req) => {
      const p = principalOf(req);
      const rows = await deps.approvals.list(p.workspaceId, req.query.status);
      return { data: rows.map(toOut) };
    },
  );

  for (const [action, decision] of [
    ["approve", "APPROVED"],
    ["reject", "REJECTED"],
  ] as const) {
    app.post(
      `/v1/approvals/:id/${action}`,
      {
        preHandler: requireScopes("approvals:write"),
        schema: { tags: ["approvals"], params: IdParams, body: ApprovalDecision.optional(), response: { 200: ApprovalOut } },
      },
      async (req) => {
        const p = principalOf(req);
        await deps.approvals.decide(p.workspaceId, req.params.id, decision, actorFrom(p), req.body?.reason);
        return toOut(await deps.approvals.get(p.workspaceId, req.params.id));
      },
    );
  }
};
