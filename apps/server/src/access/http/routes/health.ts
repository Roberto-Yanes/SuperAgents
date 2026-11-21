import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { pingDb } from "../../../data/health.js";

export type HealthDeps = Pick<AppContext, "db" | "bus" | "boss" | "env">;

const Checks = z.object({
  db: z.boolean(),
  bus: z.boolean(),
  queue: z.boolean(),
  /** enabled si hay COMPOSIO_API_KEY; disabled si falta. Nunca incluye la key. */
  composio: z.enum(["enabled", "disabled"]),
});

/**
 * /health = liveness (el proceso responde). /ready = readiness: base de datos, conexión LISTEN del bus
 * y pg-boss. El healthcheck de Docker usa /ready (L6) para que un bus caído se vea.
 */
export const healthRoutes: FastifyPluginAsyncZod<{ deps: HealthDeps }> = async (app, { deps }) => {
  app.get("/health", { schema: { tags: ["system"], response: { 200: z.object({ status: z.literal("ok") }) } } }, async () => ({ status: "ok" as const }));

  app.get(
    "/ready",
    {
      schema: {
        tags: ["system"],
        response: { 200: Checks.extend({ status: z.literal("ready") }), 503: Checks.extend({ status: z.literal("not_ready") }) },
      },
    },
    async (_req, reply) => {
      const checks = {
        db: await pingDb(deps.db),
        bus: deps.bus.isStarted() ? deps.bus.isHealthy() : true,
        queue: deps.boss ? deps.boss.isHealthy() : true,
        composio: deps.env.COMPOSIO_API_KEY ? ("enabled" as const) : ("disabled" as const),
      };
      const ok = checks.db && checks.bus && checks.queue;
      return ok ? { status: "ready" as const, ...checks } : reply.code(503).send({ status: "not_ready" as const, ...checks });
    },
  );
};
