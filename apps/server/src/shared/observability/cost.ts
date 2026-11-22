/** Tarifa de una conexión LLM, en USD por millón de tokens. Sin tarifa: la de referencia de la plataforma. */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const REFERENCE_PRICING: ModelPricing = { inputPer1M: 0.15, outputPer1M: 0.6 };

export function pricingOf(config: unknown): ModelPricing | undefined {
  const p = (config as { pricing?: { inputPer1M?: unknown; outputPer1M?: unknown } } | null)?.pricing;
  if (!p || typeof p.inputPer1M !== "number" || typeof p.outputPer1M !== "number") return undefined;
  return { inputPer1M: p.inputPer1M, outputPer1M: p.outputPer1M };
}

/**
 * Coste estimado de un uso de tokens con la tarifa de la conexión o, sin ella, la de referencia
 * (USD por millón: 0,15 de entrada y 0,60 de salida). No es la factura del proveedor.
 */
export function estimateCostUsd(usage: unknown, pricing: ModelPricing = REFERENCE_PRICING): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const total = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object" && typeof (value as { total?: unknown }).total === "number") return (value as { total: number }).total;
    return 0;
  };
  const input = total(u.inputTokens) || total(u.promptTokens);
  const output = total(u.outputTokens) || total(u.completionTokens);
  return Math.round(((input * pricing.inputPer1M + output * pricing.outputPer1M) / 1_000_000) * 1_000_000) / 1_000_000;
}
