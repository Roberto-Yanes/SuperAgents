import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { metricsRegistry } from "../../../shared/observability/metrics.js";

/** Prometheus. No lleva secretos: solo contadores de proceso y de runs terminados. */
export const metricsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/metrics", { schema: { hide: true } }, async (_req, reply) => {
    reply.header("content-type", metricsRegistry.contentType);
    return reply.send(await metricsRegistry.metrics());
  });
};
