import type { ConnectionTester } from "../../domain/connections/service.js";

type FetchLike = typeof fetch;

/**
 * Prueba de credenciales LLM sin gastar tokens: lista modelos del proveedor.
 * Devuelve unos pocos ids de ejemplo para ayudar a configurar el agente ("conexión:modelo").
 */
export function llmTester(fetchImpl: FetchLike = fetch): ConnectionTester {
  return async (conn, rawSecret) => {
    const secret = rawSecret as { apiKey?: string };
    const config = conn.config as { baseURL?: string };
    let url: string;
    const headers: Record<string, string> = {};
    switch (conn.kind) {
      case "llm.openai":
        url = `${config.baseURL ?? "https://api.openai.com/v1"}/models`;
        headers.authorization = `Bearer ${secret.apiKey}`;
        break;
      case "llm.anthropic":
        url = `${config.baseURL ?? "https://api.anthropic.com/v1"}/models`;
        headers["x-api-key"] = secret.apiKey ?? "";
        headers["anthropic-version"] = "2023-06-01";
        break;
      case "llm.google":
        url = `${config.baseURL ?? "https://generativelanguage.googleapis.com/v1beta"}/models`;
        headers["x-goog-api-key"] = secret.apiKey ?? "";
        break;
      case "llm.openai_compatible":
        url = `${config.baseURL!.replace(/\/$/, "")}/models`;
        if (secret.apiKey) headers.authorization = `Bearer ${secret.apiKey}`;
        break;
      default:
        return { ok: false, message: `Tipo LLM no soportado: ${conn.kind}` };
    }
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, message: `El proveedor respondió ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    const ids = (body.data?.map((m) => m.id) ?? body.models?.map((m) => m.name) ?? []).filter((x): x is string => Boolean(x));
    return { ok: true, message: `Credenciales válidas (${ids.length} modelos disponibles)`, details: { sampleModels: ids.slice(0, 10) } };
  };
}
