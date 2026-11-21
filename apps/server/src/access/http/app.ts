import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { fromNodeHeaders } from "better-auth/node";
import type { AppContext } from "../../container.js";
import { DomainError } from "../../shared/errors.js";
import { HTTP_STATUS, HttpError } from "./errors.js";
import { authPlugin } from "./plugins/auth.js";
import { healthRoutes } from "./routes/health.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { meRoutes } from "./routes/me.js";
import { agentRoutes } from "./routes/agents.js";
import { chatRoutes } from "./routes/chats.js";
import { conversationRoutes } from "./routes/conversations.js";
import { contactRoutes } from "./routes/contacts.js";
import { agendaRoutes } from "./routes/agenda.js";
import { leadRoutes } from "./routes/leads.js";
import { routineRoutes } from "./routes/routines.js";
import { sequenceRoutes } from "./routes/sequences.js";
import { metricsRoutes } from "./routes/metrics.js";
import { runRoutes } from "./routes/runs.js";
import { approvalRoutes } from "./routes/approvals.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { connectionRoutes } from "./routes/connections.js";
import { wsRoutes } from "./routes/ws.js";
import { webhookRoutes } from "./routes/webhooks.js";
import websocket from "@fastify/websocket";

/** API Gateway (capa 02): REST /v1 + SSE, auth, rate limit, idempotencia y contrato OpenAPI 3.1. */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log.child({ component: "http" }) as FastifyBaseLogger,
    // N7: el ticket de SSE viaja en la query. Esa petición no se loguea.
    logController: new LogController({ disableRequestLogging: (req) => /\/v1\/runs\/[^/]+\/events$/.test(req.url.split("?")[0] ?? "") }),
    // L7: confiar solo en los N saltos de proxy configurados (Caddy = 1); 0 = ignorar X-Forwarded-For.
    trustProxy: ctx.env.TRUST_PROXY === 0 ? false : (_addr: string, hop: number) => hop < ctx.env.TRUST_PROXY,
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Everglow Agentes API", version: "1.0.0", description: "Motor de agentes headless. La UI y las integraciones usan solo esta API." },
      servers: [{ url: ctx.env.PUBLIC_URL }],
      components: {
        securitySchemes: {
          apiKey: { type: "http", scheme: "bearer", description: "API key del workspace: ega_..." },
          session: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "Sesión de usuario + cabecera X-Workspace-Id" },
        },
      },
      security: [{ apiKey: [] }, { session: [] }],
    },
    transform: jsonSchemaTransform,
  });

  const origins = ctx.env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, { origin: origins.length ? origins : false, credentials: true });
  await app.register(rateLimit, {
    max: ctx.env.RATE_LIMIT_MAX,
    timeWindow: ctx.env.RATE_LIMIT_WINDOW,
    // L3: el límite se aplica por principal YA VALIDADO, no por un prefijo de cabecera que cualquiera puede inventar
    // para repartir peticiones entre "claves" falsas. El onRequest global de auth corre antes que el de cada ruta
    // (donde engancha rate-limit), así que req.principal ya está resuelto; sin principal válido cuenta la IP.
    keyGenerator: (req) => (req.principal ? `${req.principal.kind}:${req.principal.actorId}` : `ip:${req.ip}`),
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof DomainError) return reply.code(HTTP_STATUS[err.kind]).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: { code: "validation_error", message: "Petición inválida", details: err.validation } });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: "rate_limited", message: "Demasiadas peticiones" } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? "bad_request", message: err.message } });
    req.log.error({ err }, "error no controlado");
    return reply.code(500).send({ error: { code: "internal_error", message: "Error interno" } });
  });

  // Cuerpo JSON vacío (fetch con content-type json y sin body, p. ej. POST /v1/runs/:id/cancel) = sin cuerpo.
  // Se mantiene el parser seguro de Fastify (protección contra __proto__ / constructor).
  const secureJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (typeof body === "string" && body.trim() === "") return done(null, undefined);
    void secureJson(req, typeof body === "string" ? body : body.toString("utf8"), done);
  });

  // L2: 404 con el formato de error estándar (sin filtrar la ruta ni el método en el mensaje).
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Ruta no encontrada" } }));

  // Better Auth gestiona /api/auth/* (alta, login, sesión). Fastify ya parseó el cuerpo, así que se le pasa
  // una Request estándar reconstruida (patrón de la integración oficial con Fastify).
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: { hide: true },
    handler: async (req, reply) => {
      const url = new URL(req.url, ctx.env.PUBLIC_URL);
      const request = new Request(url, {
        method: req.method,
        headers: fromNodeHeaders(req.headers),
        ...(req.body !== undefined && req.method !== "GET" ? { body: JSON.stringify(req.body) } : {}),
      });
      const response = await ctx.auth.handler(request);
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });

  await app.register(authPlugin, { deps: ctx });
  await app.register(idempotencyPlugin, { deps: ctx });
  await app.register(websocket);
  const withUrl = { ...ctx, publicUrl: ctx.env.PUBLIC_URL };
  await app.register(healthRoutes, { deps: ctx });
  await app.register(agentRoutes, { deps: ctx });
  await app.register(chatRoutes, { deps: ctx });
  await app.register(conversationRoutes, { deps: ctx });
  await app.register(contactRoutes, { deps: ctx });
  await app.register(agendaRoutes, { deps: ctx });
  await app.register(leadRoutes, { deps: ctx });
  await app.register(routineRoutes, { deps: ctx });
  await app.register(sequenceRoutes, { deps: ctx });
  await app.register(metricsRoutes);
  await app.register(runRoutes, { deps: ctx });
  await app.register(meRoutes, { deps: ctx });
  await app.register(approvalRoutes, { deps: ctx });
  await app.register(apiKeyRoutes, { deps: ctx });
  await app.register(connectionRoutes, { deps: withUrl });
  await app.register(wsRoutes, { deps: withUrl });
  await app.register(webhookRoutes, { deps: ctx });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  return app;
}
