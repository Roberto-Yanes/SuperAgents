import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { IdParams, RunOut, iso } from "../schemas.js";
import { actorFrom } from "../../auth/scopes.js";
import { streamSubject, ticketPrincipal } from "../sse.js";

export type RunDeps = Pick<AppContext, "runQueries" | "bus" | "runControl" | "wsTickets">;

const RunStatus = z.enum(["QUEUED", "RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);

export const runRoutes: FastifyPluginAsyncZod<{ deps: RunDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/runs",
    {
      preHandler: requireScopes("runs:read"),
      schema: {
        tags: ["runs"],
        querystring: z.object({
          status: RunStatus.optional(),
          conversationId: z.uuid().optional(),
          agentId: z.uuid().optional(),
          cursor: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: z.object({ data: z.array(RunOut), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const { data, nextCursor } = await deps.runQueries.list(principalOf(req).workspaceId, req.query);
      return {
        nextCursor,
        data: data.map((run) => ({
          id: run.id,
          agentId: run.agentId,
          conversationId: run.conversationId,
          trigger: run.trigger,
          status: run.status,
          output: run.output,
          error: run.error,
          stepCount: run.stepCount,
          usage: run.usage,
          createdAt: iso(run.createdAt)!,
          finishedAt: iso(run.finishedAt),
        })),
      };
    },
  );

  app.post(
    "/v1/runs/:id/cancel",
    { preHandler: requireScopes("chats:write"), schema: { tags: ["runs"], params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const p = principalOf(req);
      await deps.runControl.cancel(p.workspaceId, req.params.id, actorFrom(p));
      return reply.code(204).send(null);
    },
  );

  app.get("/v1/runs/:id", { preHandler: requireScopes("runs:read"), schema: { tags: ["runs"], params: IdParams, response: { 200: RunOut } } }, async (req) => {
    const p = principalOf(req);
    const run = await deps.runQueries.get(p.workspaceId, req.params.id);
    return {
      id: run.id,
      agentId: run.agentId,
      conversationId: run.conversationId,
      trigger: run.trigger,
      status: run.status,
      output: run.output,
      error: run.error,
      stepCount: run.stepCount,
      usage: run.usage,
      createdAt: iso(run.createdAt)!,
      finishedAt: iso(run.finishedAt),
      steps: run.steps.map((s) => ({ index: s.index, kind: s.kind, toolName: s.toolName, data: s.data, createdAt: iso(s.createdAt)! })),
    };
  });

  /**
   * Streaming SSE de un run (paso E del diagrama): backlog desde Last-Event-ID / ?after y luego en vivo.
   * Eventos: run.started, message.delta, tool.called, approval.requested, message.completed, run.finished...
   */
  app.get(
    "/v1/runs/:id/events",
    {
      preHandler: [ticketPrincipal(deps), requireScopes("events:read")],
      schema: {
        tags: ["runs"],
        params: IdParams,
        querystring: z.object({ after: z.string().regex(/^\d+$/).optional(), ticket: z.string().max(100).optional() }),
        produces: ["text/event-stream"],
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const run = await deps.runQueries.get(p.workspaceId, req.params.id); // 404 si no es de este workspace
      await streamSubject(deps, req, reply, p.workspaceId, `run:${run.id}`, ["run.finished"]);
    },
  );
};
