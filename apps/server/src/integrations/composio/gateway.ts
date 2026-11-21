import { Composio } from "@composio/core";
import { z } from "zod";
import type { Db } from "../../data/db.js";
import { decryptJson } from "../../shared/security/crypto.js";
import type { Logger } from "pino";
import { effectiveApproval, type ToolProvider } from "../tools/registry.js";
import type { ToolDef, ToolExposure, ToolRisk } from "../tools/types.js";
import type { ConnectionTester } from "../../domain/connections/service.js";
import type { ApprovalMode } from "../../data/generated/prisma/enums.js";

/**
 * Composio Gateway (capa 05): acciones de Composio (Gmail, Google Calendar, HubSpot, Holded, +1800 apps)
 * expuestas como ToolDef. Pasan por las MISMAS reglas que las tools internas: scope, riesgo, aprobación y
 * registro en RunStep.
 *
 * - La API key de Composio vive solo en backend (Connection "composio", cifrada).
 * - Una entidad de Composio por workspace, construida en servidor: composioUserId(workspaceId).
 * - Cara: las acciones son internas salvo que la config diga exposure: "external" o el agente las exponga.
 * - DELETE/REMOVE siempre con aprobación ALWAYS (ningún override lo baja).
 * - Lista blanca: solo las acciones de config.tools se convierten en tools.
 * - Nombre de la tool: "composio.<slug en minúsculas>", p. ej. composio.gmail_send_email.
 */

export interface ComposioToolInfo {
  slug: string;
  description: string;
  inputParameters: Record<string, unknown>;
  toolkit: string;
}
export interface ComposioExecuteResult {
  successful: boolean;
  data: unknown;
  error: string | null;
}

/** Puerto hacia Composio (la implementación real usa @composio/core; los tests, una falsa). */
export interface ComposioClient {
  getTool(slug: string): Promise<ComposioToolInfo>;
  execute(slug: string, params: { userId: string; arguments: Record<string, unknown>; version?: string }): Promise<ComposioExecuteResult>;
}
export type ComposioClientFactory = (apiKey: string) => ComposioClient;

export const sdkComposioClient: ComposioClientFactory = (apiKey) => {
  const composio = new Composio({ apiKey });
  return {
    async getTool(slug) {
      const t = await composio.tools.getRawComposioToolBySlug(slug);
      return {
        slug: t.slug,
        description: t.description ?? t.name ?? t.slug,
        inputParameters: (t.inputParameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
        toolkit: t.toolkit?.slug ?? slug.split("_")[0]!.toLowerCase(),
      };
    },
    async execute(slug, params) {
      const r = await composio.tools.execute(slug, {
        userId: params.userId,
        arguments: params.arguments,
        // Sin versión fijada se usa la última (configurar toolkitVersions en producción).
        ...(params.version ? { version: params.version } : { dangerouslySkipVersionCheck: true }),
      });
      return { successful: r.successful, data: r.data, error: r.error };
    },
  };
};

interface ComposioConfig {
  tools: Array<{ slug: string; risk?: ToolRisk; approval?: ApprovalMode; exposure?: ToolExposure }>;
  toolkitVersions: Record<string, string>;
}

/**
 * Entidad de Composio de un workspace, construida SIEMPRE en el servidor (H5). Antes venía de la config
 * (userId), y un admin podía apuntarla a las cuentas conectadas de otro cliente que compartiera API key.
 */
export function composioUserId(workspaceId: string, purpose: "integration" = "integration"): string {
  return `ega:${workspaceId}:${purpose}`;
}

/** Aprobación de una acción: la config puede endurecer o relajar ASK_OWNER, nunca bajar el suelo (DELETE/REMOVE = ALWAYS). */
export function composioApproval(slug: string, risk: ToolRisk, configured?: ApprovalMode): ApprovalMode {
  return effectiveApproval(defaultApproval(slug, risk), configured);
}

const CACHE_TTL_MS = 10 * 60_000;

export class ComposioToolProvider implements ToolProvider {
  readonly prefix = "composio.";
  private readonly cache = new Map<string, { at: number; tools: ToolDef[] }>();

  constructor(
    private readonly db: Db,
    private readonly keys: Buffer[],
    private readonly clientFactory: ComposioClientFactory = sdkComposioClient,
    private readonly opts: { log?: Logger; requireVersions?: boolean } = {},
  ) {}

  async toolsForWorkspace(workspaceId: string): Promise<ToolDef[]> {
    const cached = this.cache.get(workspaceId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tools;
    const conn = await this.db.connection.findFirst({ where: { workspaceId, kind: "composio", status: { not: "DISABLED" } } });
    if (!conn?.secretEnc) return [];
    const { apiKey } = decryptJson<{ apiKey: string }>(conn.secretEnc, this.keys, `connection:${conn.id}`);
    const config = conn.config as unknown as ComposioConfig;
    const client = this.clientFactory(apiKey);
    const userId = composioUserId(workspaceId);
    const tools: ToolDef[] = [];
    for (const entry of config.tools ?? []) {
      // M8: una acción que falla (renombrada, sin permisos, red) no deja al agente sin el resto de tools.
      let info: Awaited<ReturnType<ComposioClient["getTool"]>>;
      let input: z.ZodType;
      try {
        info = await client.getTool(entry.slug);
        input = z.fromJSONSchema(info.inputParameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType;
      } catch (err) {
        this.opts.log?.warn({ err, slug: entry.slug, workspaceId }, "acción de Composio no disponible; se omite");
        continue;
      }
      const version = config.toolkitVersions?.[info.toolkit];
      if (!version && this.opts.requireVersions) {
        this.opts.log?.warn({ slug: info.slug, toolkit: info.toolkit, workspaceId }, "toolkit sin versión fijada en producción; acción omitida");
        continue;
      }
      const risk = entry.risk ?? inferRisk(info.slug);
      tools.push({
        name: `composio.${info.slug.toLowerCase()}`,
        description: info.description.slice(0, 1000),
        input,
        scope: `composio:${info.toolkit}`,
        risk,
        approval: composioApproval(info.slug, risk, entry.approval),
        exposure: entry.exposure ?? "internal",
        requiresConnection: "composio",
        preview: (input) => `${info.slug} ${JSON.stringify(input)}`,
        async execute(input) {
          // Composio no acepta clave de idempotencia: la protección es la aprobación única + el estado del run.
          const r = await client.execute(info.slug, { userId, arguments: input as Record<string, unknown>, version });
          return r.successful ? { ok: true, data: r.data } : { ok: false, error: r.error ?? "Composio devolvió un error" };
        },
      });
    }
    this.cache.set(workspaceId, { at: Date.now(), tools });
    return tools;
  }

  /** Llamar tras cambiar la conexión de Composio de un workspace. */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }
}

/** Riesgo por convención de nombres de Composio (VERBO en el slug). Configurable por acción. */
export function inferRisk(slug: string): ToolRisk {
  const s = slug.toUpperCase();
  if (/_(SEND|REPLY|FORWARD|POST|PUBLISH|INVITE|SHARE)(_|$)/.test(s)) return "send";
  if (/_(CREATE|UPDATE|DELETE|REMOVE|ADD|MOVE|SET|PATCH|UPLOAD|ARCHIVE|CANCEL)(_|$)/.test(s)) return "write";
  if (/_(GET|LIST|SEARCH|FETCH|READ|FIND|RETRIEVE|QUERY|COUNT)(_|$)/.test(s)) return "read";
  return "write"; // en la duda, tratarlo como escritura
}

export function defaultApproval(slug: string, risk: ToolRisk): ApprovalMode {
  if (/_(DELETE|REMOVE)(_|$)/.test(slug.toUpperCase())) return "ALWAYS";
  return risk === "read" ? "NEVER" : "ASK_OWNER";
}

export function composioTester(clientFactory: ComposioClientFactory = sdkComposioClient, requireVersions = false): ConnectionTester {
  return async (conn, rawSecret) => {
    const { apiKey } = rawSecret as { apiKey: string };
    const config = conn.config as unknown as ComposioConfig;
    const client = clientFactory(apiKey);
    const missing: string[] = [];
    for (const t of config.tools ?? []) {
      try {
        await client.getTool(t.slug);
      } catch {
        missing.push(t.slug);
      }
    }
    if (missing.length) return { ok: false, message: `Acciones no encontradas en Composio: ${missing.join(", ")}` };
    if (requireVersions && Object.keys(config.toolkitVersions ?? {}).length === 0)
      return { ok: false, message: 'En producción hay que fijar toolkitVersions (p. ej. { "gmail": "20250909_00" })' };
    return { ok: true, message: `Composio OK (${config.tools?.length ?? 0} acciones habilitadas)` };
  };
}
