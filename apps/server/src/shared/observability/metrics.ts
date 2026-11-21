import { Counter, Registry, collectDefaultMetrics } from "prom-client";

/** Registro único de métricas. /metrics lo expone; el runtime incrementa el contador de runs. */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const runsFinished = new Counter({
  name: "ega_runs_finished_total",
  help: "Runs que llegaron a un estado terminal",
  labelNames: ["status"] as const,
  registers: [metricsRegistry],
});
