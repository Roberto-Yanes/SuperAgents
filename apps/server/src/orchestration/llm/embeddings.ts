import { embedMany } from "ai";
import type { Db } from "../../data/db.js";
import type { Embedder, EmbedderResolver } from "../../domain/knowledge/service.js";
import type { ConnectionLlmResolver } from "./registry.js";

/**
 * Embeddings de la base de conocimiento con una conexión LLM UE del workspace (ADR 005).
 * Se activa con Workspace.settings.knowledge.embeddingModel = "<conexión>:<modelo>"
 * (p. ej. "mistral:mistral-embed" u "ollama:nomic-embed-text"). Sin configurar, la búsqueda es solo por texto.
 */
export class ConnectionEmbedderResolver implements EmbedderResolver {
  constructor(private readonly d: { db: Db; llm: Pick<ConnectionLlmResolver, "resolveEmbedding"> }) {}

  async forWorkspace(workspaceId: string): Promise<Embedder | null> {
    const ws = await this.d.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const ref = (ws.settings as { knowledge?: { embeddingModel?: unknown } } | null)?.knowledge?.embeddingModel;
    if (typeof ref !== "string" || !ref.includes(":")) return null;
    const { model } = await this.d.llm.resolveEmbedding(workspaceId, ref); // comprueba residencia UE
    return {
      model: ref,
      embed: async (texts) => (await embedMany({ model, values: texts, maxRetries: 2 })).embeddings,
    };
  }
}

/** Resolver fijo (tests): un embebedor dado o ninguno. */
export class StaticEmbedderResolver implements EmbedderResolver {
  constructor(private readonly embedder: Embedder | null) {}
  async forWorkspace(): Promise<Embedder | null> {
    return this.embedder;
  }
}
