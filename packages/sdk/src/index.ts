import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.js";

export type { paths, components } from "./schema.js";

/**
 * Cliente tipado de la API v1. Los tipos se generan desde openapi.json (pnpm openapi en la raíz).
 *
 * @example
 * const ega = createEgaClient({ baseUrl: "https://agentes.example.com", apiKey: process.env.EGA_API_KEY! });
 * const { data } = await ega.GET("/v1/agents");
 */
export function createEgaClient(opts: { baseUrl: string; apiKey?: string; workspaceId?: string } & Omit<ClientOptions, "baseUrl">) {
  const { apiKey, workspaceId, ...rest } = opts;
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  return createClient<paths>({ ...rest, headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) } });
}

/** Lee el stream SSE de un run: yields { id, event, data } hasta run.finished. */
export async function* streamRunEvents(baseUrl: string, runId: string, init: { apiKey?: string; lastEventId?: string; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = {};
  if (init.apiKey) headers.authorization = `Bearer ${init.apiKey}`;
  if (init.lastEventId) headers["last-event-id"] = init.lastEventId;
  const res = await fetch(`${baseUrl}/v1/runs/${runId}/events`, { headers, signal: init.signal });
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.startsWith(":")) continue;
      const field = (k: string) =>
        block
          .split("\n")
          .find((l) => l.startsWith(`${k}: `))
          ?.slice(k.length + 2) ?? "";
      const event = { id: field("id"), event: field("event"), data: JSON.parse(field("data") || "null") as unknown };
      yield event;
      if (event.event === "run.finished") return;
    }
  }
}
