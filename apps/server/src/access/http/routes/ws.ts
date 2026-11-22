import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { WebSocket } from "ws";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { parseSubject, subjectBelongsTo } from "../subjects.js";

const MAX_SUBSCRIPTIONS = 50;

const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), subject: z.string(), after: z.string().regex(/^\d+$/).optional() }),
  z.object({ type: z.literal("unsubscribe"), subject: z.string() }),
  z.object({ type: z.literal("ping") }),
]);

/**
 * WebSocket /v1/ws con tickets de un solo uso.
 * 1. El cliente autenticado pide POST /v1/ws/tickets (API key o sesión).
 * 2. Abre wss://.../v1/ws?ticket=... en menos de 60 s; el ticket se consume al conectar.
 * 3. Envía {type:"subscribe", subject:"run:<id>" | "conversation:<id>", after?} y recibe
 *    {type:"event", seq, event, subject, data}: backlog desde "after" y luego en vivo (mismo bus que SSE).
 *    "connection:<id>" (QR y estado de WhatsApp por Baileys) exige además connections:read.
 */
export type WsDeps = Pick<AppContext, "wsTickets" | "bus" | "runQueries" | "conversations" | "connections" | "tasks"> & { publicUrl: string };

export const wsRoutes: FastifyPluginAsyncZod<{ deps: WsDeps }> = async (app, { deps }) => {
  app.post(
    "/v1/ws/tickets",
    {
      preHandler: requireScopes("events:read"),
      schema: { tags: ["realtime"], response: { 201: z.object({ ticket: z.string(), expiresAt: z.string(), url: z.string() }) } },
    },
    async (req, reply) => {
      const { ticket, expiresAt } = await deps.wsTickets.issue(principalOf(req));
      const url = `${deps.publicUrl.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`;
      return reply.code(201).send({ ticket, expiresAt: expiresAt.toISOString(), url });
    },
  );

  app.get(
    "/v1/ws",
    {
      websocket: true,
      schema: { tags: ["realtime"], querystring: z.object({ ticket: z.string() }), hide: true },
      // Antes del upgrade: consumir el ticket de forma atómica (un solo uso, sin caducar).
      preValidation: async (req, reply) => {
        const row = await deps.wsTickets.consume((req.query as { ticket?: string }).ticket ?? "");
        if (!row) return reply.code(401).send({ error: { code: "invalid_ticket", message: "Ticket inválido, usado o caducado" } });
        if (!row.scopes.includes("events:read")) return reply.code(403).send({ error: { code: "forbidden", message: "Falta events:read" } });
        (req as unknown as { ws: { workspaceId: string; scopes: string[] } }).ws = row;
      },
    },
    (socket: WebSocket, req) => {
      const { workspaceId, scopes } = (req as unknown as { ws: { workspaceId: string; scopes: string[] } }).ws;
      const subs = new Map<string, () => void>();
      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };

      // Todo el handler va en try/catch: un rechazo aquí sería una unhandledRejection que tumba el proceso (C1).
      const onMessage = async (raw: Buffer) => {
        let parsed: z.infer<typeof ClientMessage>;
        try {
          parsed = ClientMessage.parse(JSON.parse(raw.toString("utf8")));
        } catch {
          return send({ type: "error", code: "bad_message", message: "Mensaje inválido" });
        }
        if (parsed.type === "ping") return send({ type: "pong" });
        if (parsed.type === "unsubscribe") {
          const key = parseSubject(parsed.subject)?.normalized ?? parsed.subject;
          subs.get(key)?.();
          subs.delete(key);
          return send({ type: "unsubscribed", subject: parsed.subject });
        }
        const match = parseSubject(parsed.subject);
        if (!match)
          return send({ type: "error", code: "bad_subject", message: "subject debe ser run:<uuid>, conversation:<uuid>, connection:<uuid> o task:<uuid>" });
        const subject = match.normalized; // los eventos se publican con el id en minúsculas
        if (subs.has(subject)) return send({ type: "subscribed", subject });
        if (subs.size >= MAX_SUBSCRIPTIONS) return send({ type: "error", code: "too_many_subscriptions", message: `Máximo ${MAX_SUBSCRIPTIONS}` });
        const kind = match.kind;
        if (kind === "connection" && !scopes.includes("connections:read"))
          return send({ type: "error", code: "forbidden", message: "Falta connections:read", subject });
        try {
          if (!(await subjectBelongsTo(deps, workspaceId, kind, match.id))) {
            return send({ type: "error", code: "not_found", message: "Recurso no encontrado", subject });
          }
          // Reserva el hueco antes del await para que dos subscribe seguidos no dupliquen la suscripción.
          if (subs.has(subject)) return send({ type: "subscribed", subject });
          const handle: { off?: () => void; cancelled: boolean } = { cancelled: false };
          subs.set(subject, () => {
            handle.cancelled = true;
            handle.off?.();
          });
          send({ type: "subscribed", subject });
          handle.off = await deps.bus.follow(workspaceId, subject, BigInt(parsed.after ?? "0"), (e) =>
            send({ type: "event", seq: e.seq, event: e.type, subject: e.subject, data: e.data }),
          );
          if (handle.cancelled || socket.readyState !== socket.OPEN) handle.off();
        } catch (err) {
          subs.delete(subject);
          req.log.error({ err, subject }, "fallo procesando subscribe por WebSocket");
          send({ type: "error", code: "internal_error", message: "Error interno", subject });
        }
      };
      socket.on("message", (raw: Buffer) => {
        onMessage(raw).catch((err: unknown) => {
          req.log.error({ err }, "fallo inesperado en el handler de WebSocket");
          send({ type: "error", code: "internal_error", message: "Error interno" });
        });
      });

      const keepAlive = setInterval(() => socket.ping(), 25_000);
      socket.on("close", () => {
        clearInterval(keepAlive);
        for (const off of subs.values()) off();
        subs.clear();
      });
    },
  );
};
