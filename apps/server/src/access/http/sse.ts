import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../container.js";
import type { Scope } from "../auth/scopes.js";
import { HttpError } from "./errors.js";

/**
 * M6: EventSource no puede enviar cabeceras → ?ticket= (POST /v1/ws/tickets, un solo uso, 60 s).
 * N7: buildApp no loguea las rutas /events, así el ticket de la query no queda en los logs.
 */
export function ticketPrincipal(deps: Pick<AppContext, "wsTickets">) {
  return async (req: FastifyRequest): Promise<void> => {
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
  };
}

/**
 * Stream SSE de un subject del bus: backlog desde Last-Event-ID / ?after y luego en vivo.
 * Se cierra al llegar un evento de `closeOn` (p. ej. run.finished, task.finished).
 */
export async function streamSubject(
  deps: Pick<AppContext, "bus">,
  req: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
  subject: string,
  closeOn: string[],
): Promise<void> {
  const q = req.query as { after?: string };
  const lastId = (req.headers["last-event-id"] as string | undefined) ?? q.after ?? "0";
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
    unsubscribe = await deps.bus.follow(workspaceId, subject, cursor, (e) => {
      if (closed) return;
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      if (closeOn.includes(e.type)) close();
    });
    if (closed) unsubscribe();
  } catch (err) {
    req.log.error({ err, subject }, "fallo abriendo el stream SSE");
    if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ code: "internal_error" })}\n\n`);
    close();
  }
}
