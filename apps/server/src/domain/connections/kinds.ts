import { z } from "zod";

/**
 * Catálogo de tipos de conexión: qué configuración (pública) y qué secreto (cifrado) exige cada uno.
 * Añadir un tipo = añadir una entrada aquí + su tester (connections/testers.ts) + quien la use.
 */
const ApprovalMode = z.enum(["NEVER", "ASK_OWNER", "ALWAYS"]);
const Risk = z.enum(["read", "write", "send"]);

export const CONNECTION_KINDS = {
  "llm.openai": {
    config: z.object({ baseURL: z.string().url().optional() }).strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  "llm.anthropic": {
    config: z.object({ baseURL: z.string().url().optional() }).strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  "llm.google": {
    config: z.object({ baseURL: z.string().url().optional() }).strict(),
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
  },
  /** Ollama, LM Studio, vLLM o proveedores con API compatible con OpenAI (p. ej. alojados en la UE). */
  "llm.openai_compatible": {
    config: z.object({ baseURL: z.string().url() }).strict(),
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
    secret: z.object({ apiKey: z.string().min(10) }).strict(),
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
