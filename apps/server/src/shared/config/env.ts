import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** api: HTTP + SSE/WS · worker: cola y canales · all: ambos en un proceso (MVP) */
  ROLE: z.enum(["api", "worker", "all"]).default("all"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  /** 32 bytes en base64: cifra los secretos de Connection (AES-256-GCM). */
  SECRET_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "SECRET_KEY debe ser 32 bytes en base64"),
  /** Clave anterior para rotación (opcional). */
  SECRET_KEY_OLD: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default(""),
  /** Alta pública de usuarios en /api/auth/sign-up. Por defecto cerrada: los usuarios se crean con la CLI (M3). */
  /** Guarda multi-tenant de Prisma (M7). Por defecto: error fuera de producción, warn en producción. */
  TENANT_GUARD: z.enum(["error", "warn", "off"]).optional(),
  /** Hosts permitidos como baseURL de conexiones LLM (coma). Vacío = cualquiera salvo metadatos/link-local (L5). */
  LLM_BASEURL_ALLOWLIST: z.string().optional(),
  AUTH_SIGNUP: z.enum(["disabled", "enabled"]).default("disabled"),
  /** Número de proxies de confianza delante (Caddy = 1). 0 = no confiar en X-Forwarded-For (L7). */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  APPROVAL_TTL_HOURS: z.coerce.number().int().min(1).default(72),
  RUN_MAX_STEPS: z.coerce.number().int().min(1).default(12),
  /** Archivos y sesiones de Baileys (volumen persistente en Docker). */
  DATA_DIR: z.string().default("./data"),
});

export type Env = z.infer<typeof Env>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuración inválida: ${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Solo para tests. */
export function resetEnvCache(): void {
  cached = undefined;
}
