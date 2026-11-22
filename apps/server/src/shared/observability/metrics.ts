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

/** Coste estimado y tokens de LLM (sin etiqueta de workspace para no disparar la cardinalidad; el detalle está en /v1/usage). */
export const llmCostUsd = new Counter({
  name: "ega_llm_cost_usd_total",
  help: "Coste estimado de LLM en USD (tarifa de la conexión o de referencia)",
  labelNames: ["provider"] as const,
  registers: [metricsRegistry],
});

export const llmTokens = new Counter({
  name: "ega_llm_tokens_total",
  help: "Tokens de LLM consumidos",
  labelNames: ["provider", "direction"] as const,
  registers: [metricsRegistry],
});
