/**
 * Estima el coste de una llamada a partir del uso de tokens.
 * Tarifa de referencia (USD por millón): 0,15 de entrada y 0,60 de salida. No es la factura del proveedor.
 */
export function estimateCostUsd(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const total = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object" && typeof (value as { total?: unknown }).total === "number") return (value as { total: number }).total;
    return 0;
  };
  const input = total(u.inputTokens) || total(u.promptTokens);
  const output = total(u.outputTokens) || total(u.completionTokens);
  return Math.round(((input * 0.15 + output * 0.6) / 1_000_000) * 1_000_000) / 1_000_000;
}
