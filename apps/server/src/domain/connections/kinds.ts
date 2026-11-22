import { z } from "zod";

/**
 * Catálogo de tipos de conexión: qué configuración (pública) y qué secreto (cifrado) exige cada uno.
 * Añadir un tipo = añadir una entrada aquí + su tester (connections/testers.ts) + quien la use.
 */
const ApprovalMode = z.enum(["NEVER", "ASK_OWNER", "ALWAYS"]);
/** Tarifa opcional de la conexión (USD por millón de tokens) para el costo de cada run. */
const Pricing = z.object({ inputPer1M: z.number().min(0).max(1_000), outputPer1M: z.number().min(0).max(1_000) }).strict();
const Risk = z.enum(["read", "write", "send", "money", "delete"]);

export const CONNECTION_KINDS = {
  /** Azure OpenAI en una región UE (ADR 005). El endpoint tiene que demostrar la región. */
  "llm.azure_openai": {
    config: z
      .object({
        provider: z.literal("azure_openai").default("azure_openai"),
        region: z.string().min(2),
        endpoint: z.string().url(),
        pricing: Pricing.optional(),
      })
      .strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  /** Mistral La Plateforme, procesamiento en la UE. */
  "llm.mistral": {
    config: z.object({ provider: z.literal("mistral").default("mistral"), region: z.literal("eu").default("eu"), pricing: Pricing.optional() }).strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  /** @deprecated ADR 005: no procesa en la UE. Se conserva para leer filas antiguas; no se puede crear ni usar. */
  "llm.openai": {
    config: z.object({ baseURL: z.string().url().optional() }).strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  /** @deprecated ADR 005 (ídem). */
  "llm.anthropic": {
    config: z.object({ baseURL: z.string().url().optional() }).strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  /** @deprecated ADR 005 (ídem). */
  "llm.google": {
    config: z.object({ baseURL: z.string().url().optional() }).strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  /**
   * API compatible con OpenAI en la UE: "self_hosted" (Ollama/vLLM en el mismo servidor o su red privada)
   * o "eu_hosted" (host público UE declarado en llmPolicy.hosts del workspace).
   */
  "llm.openai_compatible": {
    config: z
      .object({ baseURL: z.string().url(), provider: z.enum(["self_hosted", "eu_hosted"]), region: z.string().min(2), pricing: Pricing.optional() })
      .strict(),
    secret: z.object({ apiKey: z.string().optional() }).strict(),
  },
  composio: {
    config: z
      .object({
        /** Lista blanca de acciones habilitadas, con riesgo y aprobación opcionales (si no, se infieren). */
        tools: z
          .array(
            z.object({
              slug: z.string().regex(/^[A-Z0-9_]+$/),
              risk: Risk.optional(),
              approval: ApprovalMode.optional(),
              /** "external": disponible también en conversaciones con contactos. Por defecto, solo interna. */
              exposure: z.enum(["internal", "external"]).optional(),
            }),
          )
          .default([]),
        /** Versiones fijadas por toolkit (recomendado en producción): { "gmail": "20250909_00" } */
        toolkitVersions: z.record(z.string(), z.string()).default({}),
      })
      .strict(),
    /**
     * La API key es del servidor (COMPOSIO_API_KEY), no de la conexión. Cualquier apiKey aquí se rechaza
     * para que no quede cifrada por workspace.
     */
    secret: z
      .object({ apiKey: z.string().optional() })
      .strict()
      .superRefine((value, ctx) => {
        if (value.apiKey !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: "La API key de Composio es única por servidor (COMPOSIO_API_KEY) y no se acepta ni se guarda en la conexión.",
          });
        }
      })
      .transform(() => ({})),
  },
  "channel.whatsapp_cloud": {
    config: z
      .object({
        agentId: z.string().uuid(),
        phoneNumberId: z.string().min(1),
        wabaId: z.string().optional(),
        graphApiVersion: z
          .string()
          .regex(/^v\d+\.\d+$/)
          .default("v23.0"),
      })
      .strict(),
    secret: z.object({ accessToken: z.string().min(10), appSecret: z.string().min(8), verifyToken: z.string().min(8) }).strict(),
  },
  /** Sesión de WhatsApp Web por QR (solo pilotos: ver docs/DECISIONS.md D-010). La sesión vive en disco. */
  "channel.whatsapp_baileys": {
    config: z.object({ agentId: z.string().uuid() }).strict(),
    secret: z.object({}).strict(),
  },
} as const satisfies Record<string, { config: z.ZodType; secret: z.ZodType }>;

export type ConnectionKind = keyof typeof CONNECTION_KINDS;
export const CONNECTION_KIND_NAMES = Object.keys(CONNECTION_KINDS) as [ConnectionKind, ...ConnectionKind[]];

export function isConnectionKind(v: string): v is ConnectionKind {
  return v in CONNECTION_KINDS;
}

export type ConfigOf<K extends ConnectionKind> = z.infer<(typeof CONNECTION_KINDS)[K]["config"]>;
export type SecretOf<K extends ConnectionKind> = z.infer<(typeof CONNECTION_KINDS)[K]["secret"]>;
