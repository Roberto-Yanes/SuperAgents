import { env } from "./shared/config/env.js";
import { closeContext, createContext } from "./container.js";
import { buildApp } from "./access/http/app.js";
import { startWorkers } from "./execution/workers/index.js";

/**
 * ROLE=api     → HTTP (REST, SSE) + bus de eventos.
 * ROLE=worker  → cola pg-boss, runtime y canales.
 * ROLE=all     → todo en un proceso (MVP: corre 24/7 aunque no haya UI abierta).
 */
async function main(): Promise<void> {
  const config = env();
  const ctx = createContext(config);

  // Última red: una promesa rechazada sin catch se registra y NO tumba el proceso (C1).
  // Una excepción síncrona sin capturar deja el proceso en estado desconocido: se registra y se sale (Docker reinicia).
  process.on("unhandledRejection", (reason) => ctx.log.error({ err: reason }, "unhandledRejection"));
  process.on("uncaughtException", (err) => {
    ctx.log.fatal({ err }, "uncaughtException; saliendo");
    process.exit(1);
  });
  const role = config.ROLE;

  await ctx.boss?.start();
  if (role === "api" || role === "all") await ctx.bus.start();
  if (role === "worker" || role === "all") await startWorkers(ctx);

  const app = role === "api" || role === "all" ? await buildApp(ctx) : null;
  if (app) await app.listen({ host: config.HOST, port: config.PORT });
  ctx.log.info({ role }, "everglow-agentes en marcha");

  const shutdown = async (signal: string) => {
    ctx.log.info({ signal }, "apagando");
    await app?.close();
    await closeContext(ctx);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
