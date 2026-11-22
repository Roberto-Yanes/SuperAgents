import { assertAllowedBaseUrl } from "../../shared/security/url-policy.js";
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { Db } from "../../data/db.js";
import { decryptJson } from "../../shared/security/crypto.js";
import { invalid } from "../../shared/errors.js";
import { assertEuResidency, llmPolicyOf, residencyOf } from "../../domain/connections/llm-residency.js";

/**
 * Capa LLM. El agente referencia su modelo como "<nombreDeConexión>:<idDeModelo>",
 * p. ej. "mistral:mistral-medium-latest" u "ollama:llama3.1". La conexión guarda la API key del workspace.
 * Solo proveedores con residencia UE (ADR 005): Azure OpenAI UE, Mistral, eu_hosted y self_hosted.
 */
export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  /** Proveedor y región comprobados (ADR 005). Van a la auditoría de cada tramo. */
  provider: string;
  region: string;
}

export interface LlmResolver {
  resolve(workspaceId: string, modelRef: string): Promise<ResolvedModel>;
}

const Secret = z.object({ apiKey: z.string().optional() }).passthrough();
const Config = z.object({ baseURL: z.string().url().optional(), endpoint: z.string().url().optional() }).passthrough();

export class ConnectionLlmResolver implements LlmResolver {
  constructor(
    private readonly db: Db,
    private readonly keys: Buffer[],
    private readonly baseUrlAllowlist: string[] = [],
  ) {}

  async resolve(workspaceId: string, modelRef: string): Promise<ResolvedModel> {
    const sep = modelRef.indexOf(":");
    if (sep <= 0) throw invalid("invalid_model", `Modelo inválido: "${modelRef}". Formato: conexión:modelo`);
    const connectionName = modelRef.slice(0, sep);
    const modelId = modelRef.slice(sep + 1);
    const conn = await this.db.connection.findFirst({
      where: { workspaceId, name: connectionName, kind: { startsWith: "llm." }, status: { not: "DISABLED" } },
    });
    if (!conn) throw invalid("llm_connection_missing", `No existe la conexión LLM "${connectionName}"`);
    // ADR 005: la residencia se vuelve a comprobar al usarla. Una fila antigua o una política más estricta bloquean
    // ANTES de descifrar la clave y de llamar al modelo (la tarea queda BLOCKED con motivo model_region).
    const ws = await this.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const { provider, region } = assertEuResidency(residencyOf(conn.kind, conn.config), llmPolicyOf(ws.settings));
    const config = Config.parse(conn.config);
    for (const url of [config.baseURL, config.endpoint]) if (url) assertAllowedBaseUrl(url, this.baseUrlAllowlist);
    const secret = conn.secretEnc ? Secret.parse(decryptJson(conn.secretEnc, this.keys, `connection:${conn.id}`)) : {};

    const build = (): LanguageModel => {
      switch (conn.kind) {
        case "llm.azure_openai": // API v1 de Azure OpenAI, compatible con OpenAI; la clave va en api-key
          return createOpenAICompatible({
            name: connectionName,
            baseURL: `${config.endpoint!.replace(/\/$/, "")}/openai/v1`,
            headers: { "api-key": secret.apiKey ?? "" },
          })(modelId);
        case "llm.mistral":
          return createOpenAICompatible({ name: connectionName, baseURL: "https://api.mistral.ai/v1", apiKey: secret.apiKey })(modelId);
        case "llm.openai_compatible": // Ollama / vLLM en la UE (self_hosted o eu_hosted)
          return createOpenAICompatible({ name: connectionName, baseURL: config.baseURL!, apiKey: secret.apiKey })(modelId);
        default:
          throw invalid("llm_kind_unsupported", `Tipo de conexión LLM no soportado: ${conn.kind}`);
      }
    };
    return { model: build(), modelId, provider, region };
  }
}

/** Resolver fijo para tests y demos. */
export class StaticLlmResolver implements LlmResolver {
  constructor(
    private readonly model: LanguageModel | (() => LanguageModel),
    private readonly info: { provider: string; region: string } = { provider: "test", region: "eu" },
  ) {}
  async resolve(_workspaceId: string, modelRef: string): Promise<ResolvedModel> {
    return { model: typeof this.model === "function" ? this.model() : this.model, modelId: modelRef, ...this.info };
  }
}
