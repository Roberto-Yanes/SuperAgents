import { isIP } from "node:net";
import { z } from "zod";
import { DomainError } from "../../shared/errors.js";

/**
 * Residencia UE de los modelos (ADR 005). Regla de producto, no dictamen jurídico:
 * cada conexión LLM declara proveedor y región de la UE; si la región no se puede comprobar, no se guarda.
 * La misma comprobación corre al guardar la conexión y al armar el cliente del modelo.
 */

/** Proveedores de la lista de la plataforma. El tenant puede achicarla (llmPolicy.allowed), nunca ampliarla. */
export const LLM_PROVIDERS = ["azure_openai", "mistral", "eu_hosted", "self_hosted"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Regiones aceptadas: Azure UE, códigos de país de la UE, "eu" y ubicaciones de Hetzner en la UE. */
const AZURE_EU_REGIONS = [
  "swedencentral",
  "francecentral",
  "francesouth",
  "germanywestcentral",
  "germanynorth",
  "westeurope",
  "northeurope",
  "italynorth",
  "polandcentral",
  "spaincentral",
] as const;
const EU_COUNTRIES = [
  "at",
  "be",
  "bg",
  "hr",
  "cy",
  "cz",
  "dk",
  "ee",
  "fi",
  "fr",
  "de",
  "gr",
  "hu",
  "ie",
  "it",
  "lv",
  "lt",
  "lu",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "si",
  "es",
  "se",
];
const HETZNER_EU = ["fsn1", "nbg1", "hel1"];
export const EU_REGIONS = new Set<string>(["eu", ...AZURE_EU_REGIONS, ...EU_COUNTRIES, ...HETZNER_EU]);

/** Hosts que nunca procesan en la UE para este producto (xAI, APIs públicas globales). */
const FORBIDDEN_HOST_SUFFIXES = ["x.ai", "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "api.groq.com", "api.together.xyz"];

/** Política del workspace (Workspace.settings.llmPolicy). */
export const LlmPolicySchema = z
  .object({
    /** Subconjunto de LLM_PROVIDERS. Por defecto, toda la lista. */
    allowed: z.array(z.enum(LLM_PROVIDERS)).optional(),
    /** Hosts UE que el negocio declara para "eu_hosted" (su vLLM en una VPC europea, otro proveedor UE). */
    hosts: z.array(z.string().min(1).max(253)).max(50).optional(),
  })
  .strict();
export type LlmPolicy = z.infer<typeof LlmPolicySchema>;

export function llmPolicyOf(settings: unknown): LlmPolicy {
  const raw = (settings as { llmPolicy?: unknown } | null)?.llmPolicy;
  const parsed = LlmPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { allowed: [] }; // política corrupta: no se permite nada (fallo cerrado)
}

/** Lo que una conexión LLM tiene que declarar (sin la clave). */
export interface LlmResidency {
  kind: string;
  provider?: string;
  region?: string;
  /** Endpoint efectivo (baseURL o endpoint de Azure). */
  url?: string;
}

export class ModelRegionError extends DomainError {
  constructor(code: "model_region" | "model_provider", message: string) {
    super("forbidden", code, message);
    this.name = "ModelRegionError";
  }
}

const reject = (code: "model_region" | "model_provider", message: string): never => {
  throw new ModelRegionError(code, message);
};

function hostOf(url: string | undefined): string {
  if (!url) return reject("model_region", "Falta el endpoint del modelo");
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return reject("model_region", "Endpoint del modelo inválido");
  }
}

function endsWithHost(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Host interno del mismo servidor o de su red privada (Ollama del VPS, contenedor vecino). */
function isInternalHost(host: string): boolean {
  if (host === "localhost" || !host.includes(".")) return true; // nombre de servicio de Docker ("ollama")
  if (isIP(host) === 4) return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/i.test(host);
  return host.endsWith(".internal") || host.endsWith(".local");
}

/**
 * Comprueba que una conexión LLM cumple la política de la plataforma y la del workspace.
 * Lanza ModelRegionError (sin eco de la clave: este código nunca la recibe).
 */
export function assertEuResidency(conn: LlmResidency, policy: LlmPolicy): { provider: LlmProvider; region: string; host: string } {
  const provider = conn.provider as LlmProvider | undefined;
  if (!provider || !(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    reject("model_provider", `Proveedor de modelo no permitido${conn.provider ? `: ${conn.provider}` : ""}. Opciones: ${LLM_PROVIDERS.join(", ")}`);
  }
  const p = provider as LlmProvider;
  if (policy.allowed && !policy.allowed.includes(p)) reject("model_provider", `El workspace no permite el proveedor ${p}`);
  const region = (conn.region ?? "").toLowerCase();
  if (!EU_REGIONS.has(region)) reject("model_region", `Región no válida o fuera de la UE: "${conn.region ?? ""}"`);
  const host = hostOf(conn.url);
  if (FORBIDDEN_HOST_SUFFIXES.some((s) => endsWithHost(host, s))) reject("model_region", `El host ${host} no procesa en la UE`);

  switch (p) {
    case "azure_openai": {
      if (conn.kind !== "llm.azure_openai") reject("model_provider", "azure_openai exige el tipo llm.azure_openai");
      if (!(AZURE_EU_REGIONS as readonly string[]).includes(region)) reject("model_region", `Azure: ${region} no es una región UE de Azure`);
      // La región tiene que poder leerse en el host: endpoint regional o recurso con la región en el nombre.
      const regional = host === `${region}.api.cognitive.microsoft.com`;
      const resource = (host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com")) && host.split(".")[0]!.includes(region);
      if (!regional && !resource) {
        reject(
          "model_region",
          `Azure: el host ${host} no demuestra la región ${region} (usa ${region}.api.cognitive.microsoft.com o un recurso con "${region}" en el nombre)`,
        );
      }
      break;
    }
    case "mistral":
      if (conn.kind !== "llm.mistral") reject("model_provider", "mistral exige el tipo llm.mistral");
      if (region !== "eu") reject("model_region", "Mistral: la región tiene que ser eu");
      if (host !== "api.mistral.ai") reject("model_region", `Mistral: host no permitido ${host}`);
      break;
    case "eu_hosted":
      if (conn.kind !== "llm.openai_compatible") reject("model_provider", "eu_hosted exige el tipo llm.openai_compatible");
      if (!(policy.hosts ?? []).map((h) => h.toLowerCase()).includes(host)) {
        reject("model_region", `El host ${host} no está en la lista UE del workspace (llmPolicy.hosts)`);
      }
      break;
    case "self_hosted":
      if (conn.kind !== "llm.openai_compatible") reject("model_provider", "self_hosted exige el tipo llm.openai_compatible");
      if (!isInternalHost(host))
        reject("model_region", `self_hosted solo admite el mismo servidor o su red privada (recibido ${host}); para un host público usa eu_hosted`);
      break;
  }
  return { provider: p, region, host };
}

/** Datos de residencia a partir de la fila de la conexión (kind + config pública). */
export function residencyOf(kind: string, config: unknown): LlmResidency {
  const c = (config ?? {}) as { provider?: string; region?: string; baseURL?: string; endpoint?: string };
  if (kind === "llm.mistral") return { kind, provider: "mistral", region: c.region ?? "eu", url: c.baseURL ?? "https://api.mistral.ai/v1" };
  return {
    kind,
    ...(c.provider ? { provider: c.provider } : {}),
    ...(c.region ? { region: c.region } : {}),
    ...((c.endpoint ?? c.baseURL) ? { url: c.endpoint ?? c.baseURL } : {}),
  };
}
