import { assertAllowedBaseUrl } from "../../shared/security/url-policy.js";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { Db } from "../../data/db.js";
import { decryptJson } from "../../shared/security/crypto.js";
import { invalid } from "../../shared/errors.js";

/**
 * Capa LLM. El agente referencia su modelo como "<nombreDeConexión>:<idDeModelo>",
 * p. ej. "openai-main:gpt-5-mini" o "ollama:llama3.1". La conexión guarda la API key del workspace.
 */
export interface LlmResolver {
  resolve(workspaceId: string, modelRef: string): Promise<LanguageModel>;
}

const Secret = z.object({ apiKey: z.string().optional() }).passthrough();
const Config = z.object({ baseURL: z.string().url().optional() }).passthrough();

export class ConnectionLlmResolver implements LlmResolver {
  constructor(
    private readonly db: Db,
    private readonly keys: Buffer[],
    private readonly baseUrlAllowlist: string[] = [],
  ) {}

  async resolve(workspaceId: string, modelRef: string): Promise<LanguageModel> {
    const sep = modelRef.indexOf(":");
    if (sep <= 0) throw invalid("invalid_model", `Modelo inválido: "${modelRef}". Formato: conexión:modelo`);
    const connectionName = modelRef.slice(0, sep);
    const modelId = modelRef.slice(sep + 1);
    const conn = await this.db.connection.findFirst({
      where: { workspaceId, name: connectionName, kind: { startsWith: "llm." }, status: { not: "DISABLED" } },
    });
    if (!conn) throw invalid("llm_connection_missing", `No existe la conexión LLM "${connectionName}"`);
    const secret = conn.secretEnc ? Secret.parse(decryptJson(conn.secretEnc, this.keys, `connection:${conn.id}`)) : {};
    const config = Config.parse(conn.config);
    if (config.baseURL) assertAllowedBaseUrl(config.baseURL, this.baseUrlAllowlist); // también al usarla (config antigua)

    switch (conn.kind) {
      case "llm.openai":
        return createOpenAI({ apiKey: secret.apiKey, baseURL: config.baseURL })(modelId);
      case "llm.anthropic":
        return createAnthropic({ apiKey: secret.apiKey, baseURL: config.baseURL })(modelId);
      case "llm.google":
        return createGoogleGenerativeAI({ apiKey: secret.apiKey, baseURL: config.baseURL })(modelId);
      case "llm.openai_compatible": // Ollama, LM Studio, vLLM, proveedores UE con API compatible
        if (!config.baseURL) throw invalid("llm_config", "llm.openai_compatible requiere baseURL");
        return createOpenAICompatible({ name: connectionName, baseURL: config.baseURL, apiKey: secret.apiKey })(modelId);
      default:
        throw invalid("llm_kind_unsupported", `Tipo de conexión LLM no soportado: ${conn.kind}`);
    }
  }
}

/** Resolver fijo para tests y demos. */
export class StaticLlmResolver implements LlmResolver {
  constructor(private readonly model: LanguageModel | (() => LanguageModel)) {}
  async resolve(): Promise<LanguageModel> {
    return typeof this.model === "function" ? this.model() : this.model;
  }
}
