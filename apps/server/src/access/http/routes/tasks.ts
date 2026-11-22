import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import type { Task } from "../../../data/generated/prisma/client.js";
import { limitsOf, timeUsedMs } from "../../../domain/tasks/limits.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { IdParams, TaskCreateIn, TaskLimitsIn, TaskOut, TaskSourceEnum, TaskStatusEnum, iso } from "../schemas.js";
import { streamSubject, ticketPrincipal } from "../sse.js";

export type TaskDeps = Pick<AppContext, "tasks" | "bus" | "wsTickets">;

type TaskWithRelations = Task & {
  runs?: Array<{
    id: string;
    status: string;
    trigger: string;
    stepCount: number;
    costUsd: { toString(): string };
    createdAt: Date;
    finishedAt: Date | null;
    error: string | null;
  }>;
  children?: Array<{ id: string; status: Task["status"]; goal: string }>;
};

function taskOut(t: TaskWithRelations) {
  return {
    id: t.id,
    agentId: t.agentId,
    goal: t.goal,
    source: t.source,
    launchedBy: t.launchedBy,
    status: t.status,
    conversationId: t.conversationId,
    contactId: t.contactId,
    parentTaskId: t.parentTaskId,
    depth: t.depth,
    plan: t.plan,
    planVersion: t.planVersion,
    context: t.context,
    limits: limitsOf(t.limits),
    spent: { steps: t.spentSteps, costUsd: Number(t.spentCostUsd.toString()), timeMs: timeUsedMs(t) },
    blockedReason: t.blockedReason,
    waiting: t.waiting ?? null,
    result: t.result,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
    finishedAt: iso(t.finishedAt),
    ...(t.runs
      ? {
          runs: t.runs.map((r) => ({
            id: r.id,
            status: r.status,
            trigger: r.trigger,
            stepCount: r.stepCount,
            costUsd: Number(r.costUsd.toString()),
            createdAt: r.createdAt.toISOString(),
            finishedAt: iso(r.finishedAt),
            error: r.error,
          })),
        }
      : {}),
    ...(t.children ? { children: t.children } : {}),
  };
}

/**
 * Tareas autónomas (ADR 003, E5): el dueño lanza un objetivo y sigue el plan por el bus.
 * El workspace sale siempre del principal, nunca del cuerpo.
 */
export const taskRoutes: FastifyPluginAsyncZod<{ deps: TaskDeps }> = async (app, { deps }) => {
  app.post(
    "/v1/tasks",
    { preHandler: requireScopes("tasks:write"), schema: { tags: ["tasks"], body: TaskCreateIn, response: { 201: TaskOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const task = await deps.tasks.create(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send(taskOut(task));
    },
  );

  app.get(
    "/v1/tasks",
    {
      preHandler: requireScopes("tasks:read"),
      schema: {
        tags: ["tasks"],
        querystring: z.object({
          status: TaskStatusEnum.optional(),
          source: TaskSourceEnum.optional(),
          agentId: z.uuid().optional(),
          parentTaskId: z.uuid().optional(),
          cursor: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: z.object({ data: z.array(TaskOut), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const { data, nextCursor } = await deps.tasks.list(principalOf(req).workspaceId, req.query);
      return { data: data.map(taskOut), nextCursor };
    },
  );

  app.get(
    "/v1/tasks/:id",
    { preHandler: requireScopes("tasks:read"), schema: { tags: ["tasks"], params: IdParams, response: { 200: TaskOut } } },
    async (req) => taskOut(await deps.tasks.get(principalOf(req).workspaceId, req.params.id)),
  );

  app.post(
    "/v1/tasks/:id/cancel",
    { preHandler: requireScopes("tasks:write"), schema: { tags: ["tasks"], params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const p = principalOf(req);
      await deps.tasks.cancel(p.workspaceId, req.params.id, actorFrom(p));
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/v1/tasks/:id/limits",
    { preHandler: requireScopes("tasks:write"), schema: { tags: ["tasks"], params: IdParams, body: TaskLimitsIn, response: { 200: TaskOut } } },
    async (req) => {
      const p = principalOf(req);
      return taskOut(await deps.tasks.extendLimits(p.workspaceId, req.params.id, req.body, actorFrom(p)));
    },
  );

  app.post(
    "/v1/tasks/:id/signal",
    {
      preHandler: requireScopes("tasks:write"),
      schema: {
        tags: ["tasks"],
        params: IdParams,
        body: z.object({ message: z.string().min(1).max(4_000) }),
        response: { 202: z.object({ accepted: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      await deps.tasks.signal(p.workspaceId, req.params.id, req.body.message, actorFrom(p));
      return reply.code(202).send({ accepted: true as const });
    },
  );

  /**
   * SSE de una tarea: task.created, task.status, task.plan, task.step, task.delegated, task.blocked, task.finished…
   * Los detalles de cada tramo (deltas, tools, aprobaciones) van en run:<runId>; task.step y task.status traen el runId.
   */
  app.get(
    "/v1/tasks/:id/events",
    {
      preHandler: [ticketPrincipal(deps), requireScopes("events:read")],
      schema: {
        tags: ["tasks"],
        params: IdParams,
        querystring: z.object({ after: z.string().regex(/^\d+$/).optional(), ticket: z.string().max(100).optional() }),
        produces: ["text/event-stream"],
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const task = await deps.tasks.get(p.workspaceId, req.params.id); // 404 si no es de este workspace
      await streamSubject(deps, req, reply, p.workspaceId, `task:${task.id}`, ["task.finished"]);
    },
  );
};
