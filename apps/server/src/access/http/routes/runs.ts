import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { IdParams, RunOut, iso } from "../schemas.js";
import { actorFrom, type Scope } from "../../auth/scopes.js";
import { HttpError } from "../errors.js";

export type RunDeps = Pick<AppContext, "runQueries" | "bus" | "runControl" | "wsTickets">;

const RunStatus = z.enum(["QUEUED", "RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCELLED"]);

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
      // M6: EventSource no puede enviar cabeceras → ?ticket= (POST /v1/ws/tickets, un solo uso, 60 s).
      // N7: buildApp no loguea esta ruta, así el ticket de la query no queda en los logs.
      preHandler: [
        async (req) => {
          const ticket = (req.query as { ticket?: string }).ticket;
          if (!ticket || req.principal) return;
          const row = await deps.wsTickets.consume(ticket);
          if (!row) throw new HttpError(401, "invalid_ticket", "Ticket inválido, usado o caducado");
          req.principal = {
            kind: row.actorType === "user" ? "user" : "api_key",
            actorId: row.actorId,
            workspaceId: row.workspaceId,
            scopes: new Set(row.scopes as Scope[]),
          };
        },
        requireScopes("events:read"),
      ],
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
      const subject = `run:${run.id}`;
      const lastId = (req.headers["last-event-id"] as string | undefined) ?? req.query.after ?? "0";
      const cursor = BigInt(/^\d+$/.test(lastId) ? lastId : "0");

      // hijack salta los hooks de respuesta: se copian las cabeceras ya fijadas (CORS, request-id) (M6).
      const inherited = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined)) as Record<string, string | number | string[]>;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...inherited,
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe?.();
        res.end();
      }
      req.raw.on("close", close);
      try {
        unsubscribe = await deps.bus.follow(p.workspaceId, subject, cursor, (e) => {
          if (closed) return;
          res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
          if (e.type === "run.finished") close();
        });
        if (closed) unsubscribe();
      } catch (err) {
        req.log.error({ err, subject }, "fallo abriendo el stream SSE");
        if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ code: "internal_error" })}\n\n`);
        close();
      }
    },
  );
};
