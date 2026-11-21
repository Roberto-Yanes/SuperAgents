import type { FastifyPluginAsync } from "fastify";
import type { AppContext } from "../../../container.js";
import { isUuid } from "../../../shared/validation.js";
import { JOBS } from "../../../execution/queue/jobs.js";
import { parseCloudWebhook, verifyMetaSignature } from "../../../integrations/channels/whatsapp-cloud.js";

export type WebhookDeps = Pick<AppContext, "connections" | "conversations" | "queue" | "log">;

const STATUS = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" } as const;

/**
 * Webhooks entrantes (paso 1 del flujo WhatsApp). Sin autenticación de API: se verifica la FIRMA del proveedor.
 * Este plugin parsea JSON como Buffer para poder calcular el HMAC sobre el cuerpo crudo.
 */
export const webhookRoutes: FastifyPluginAsync<{ deps: WebhookDeps }> = async (app, { deps }) => {
  app.removeContentTypeParser("application/json"); // el parser global lo convierte en objeto; aquí hace falta el cuerpo crudo
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  const loadCloud = async (connectionId: string) => {
    if (!isUuid(connectionId)) return null; // L1: nunca consultar una columna uuid con texto arbitrario
    const conn = await deps.connections.findById(connectionId);
    if (!conn || conn.kind !== "channel.whatsapp_cloud" || conn.status === "DISABLED") return null;
    return { conn, secret: deps.connections.readSecret<{ appSecret: string; verifyToken: string }>(conn) };
  };

  /** Verificación de suscripción de Meta: devuelve hub.challenge si el verify token coincide. */
  app.get<{ Params: { connectionId: string }; Querystring: Record<string, string> }>(
    "/webhooks/whatsapp/:connectionId",
    { schema: { hide: true } },
    async (req, reply) => {
      const found = await loadCloud(req.params.connectionId.toLowerCase());
      const q = req.query;
      if (!found || q["hub.mode"] !== "subscribe" || q["hub.verify_token"] !== found.secret.verifyToken) return reply.code(403).send("forbidden");
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    },
  );

  app.post<{ Params: { connectionId: string } }>("/webhooks/whatsapp/:connectionId", { schema: { hide: true }, bodyLimit: 2_097_152 }, async (req, reply) => {
    const found = await loadCloud(req.params.connectionId.toLowerCase());
    if (!found) return reply.code(404).send();
    const raw = req.body as Buffer;
    if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, found.secret.appSecret)) {
      deps.log.warn({ connectionId: found.conn.id }, "webhook de WhatsApp con firma inválida");
      return reply.code(401).send();
    }
    const { messages, statuses } = parseCloudWebhook(JSON.parse(raw.toString("utf8")));
    for (const m of messages) {
      await deps.queue.send(JOBS.channelInbound, {
        workspaceId: found.conn.workspaceId,
        connectionId: found.conn.id,
        channel: "whatsapp",
        externalThreadId: m.from,
        channelMessageId: m.wamid,
        from: { id: m.from, ...(m.name ? { name: m.name } : {}) },
        text: m.text,
        receivedAt: new Date().toISOString(),
      });
    }
    for (const s of statuses) await deps.conversations.markDelivery(found.conn.workspaceId, s.wamid, STATUS[s.status]);
    // Meta reintenta si no recibe 200 rápido: el trabajo pesado va a la cola.
    return reply.code(200).send();
  });
};
