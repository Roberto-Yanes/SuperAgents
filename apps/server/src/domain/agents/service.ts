import { z } from "zod";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import { invalid, notFound } from "../../shared/errors.js";
/**
 * Puerto del dominio: lo único que el servicio de agentes necesita saber de las tools.
 * Lo implementa integrations/tools/registry (ToolRegistry); el dominio no depende de integraciones.
 */
export interface ToolNameChecker {
  unknownNames(workspaceId: string, names: string[]): Promise<string[]>;
}
import { audit, type Actor } from "../../data/audit.js";

export const ApprovalModeSchema = z.enum(["NEVER", "ASK_OWNER", "ALWAYS"]);

const AgentFields = z.object({
  name: z.string().min(1).max(120),
  instructions: z.string().min(1).max(20_000),
  model: z.string().regex(/^[\w.-]+:.+$/, "Formato conexión:modelo"),
  tools: z.array(z.string()),
  approvals: z.record(z.string(), ApprovalModeSchema),
  /** Tools internas permitidas también con contactos externos (subconjunto de tools). */
  external: z.array(z.string()),
  settings: z.object({ maxSteps: z.number().int().min(1).max(50).optional() }),
});

/** Alta: tools, approvals y settings opcionales con valor por defecto. */
export const AgentInput = AgentFields.extend({
  tools: AgentFields.shape.tools.default([]),
  approvals: AgentFields.shape.approvals.default({}),
  external: AgentFields.shape.external.default([]),
  settings: AgentFields.shape.settings.default({}),
});
export type AgentInput = z.infer<typeof AgentInput>;

/** Edición parcial: SIN valores por defecto (un campo ausente no se toca). */
export const AgentPatch = AgentFields.partial().extend({ status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional() });
export type AgentPatch = z.infer<typeof AgentPatch>;

export class AgentService {
  constructor(
    private readonly db: Db,
    private readonly tools: ToolNameChecker,
  ) {}

  list(workspaceId: string) {
    return this.db.agent.findMany({ where: { workspaceId, status: { not: "ARCHIVED" } }, orderBy: { createdAt: "asc" } });
  }

  async get(workspaceId: string, id: string) {
    const agent = await this.db.agent.findFirst({ where: { id, workspaceId } });
    if (!agent) throw notFound("Agente");
    return agent;
  }

  async create(workspaceId: string, input: AgentInput, actor: Actor) {
    await this.assertTools(workspaceId, input.tools, input.external);
    const agent = await this.db.agent.create({
      data: {
        workspaceId,
        name: input.name,
        instructions: input.instructions,
        model: input.model,
        toolConfig: { tools: input.tools, approvals: input.approvals, external: input.external },
        settings: input.settings as Prisma.InputJsonValue,
      },
    });
    await audit(this.db, { workspaceId, actor, action: "agent.created", target: `agent:${agent.id}` });
    return agent;
  }

  async update(workspaceId: string, id: string, patch: AgentPatch, actor: Actor) {
    const current = await this.get(workspaceId, id);
    const toolConfig = current.toolConfig as { tools?: string[]; approvals?: Record<string, string>; external?: string[] };
    const tools = patch.tools ?? toolConfig.tools ?? [];
    const external = (patch.external ?? toolConfig.external ?? []).filter((n) => patch.external !== undefined || tools.includes(n));
    if (patch.tools || patch.external) await this.assertTools(workspaceId, tools, external);
    const behaviourChanged =
      patch.instructions !== undefined ||
      patch.tools !== undefined ||
      patch.approvals !== undefined ||
      patch.external !== undefined ||
      patch.model !== undefined;
    const agent = await this.db.agent.update({
      where: { id: current.id },
      data: {
        name: patch.name,
        instructions: patch.instructions,
        model: patch.model,
        status: patch.status,
        settings: patch.settings as Prisma.InputJsonValue | undefined,
        toolConfig: { tools, approvals: patch.approvals ?? toolConfig.approvals ?? {}, external },
        version: behaviourChanged ? { increment: 1 } : undefined,
      },
    });
    await audit(this.db, { workspaceId, actor, action: "agent.updated", target: `agent:${id}`, data: { fields: Object.keys(patch) } });
    return agent;
  }

  private async assertTools(workspaceId: string, names: string[], external: string[] = []): Promise<void> {
    const unknown = await this.tools.unknownNames(workspaceId, names);
    if (unknown.length > 0) throw invalid("unknown_tools", `Tools desconocidas: ${unknown.join(", ")}`);
    const notEnabled = external.filter((n) => !names.includes(n));
    if (notEnabled.length > 0) throw invalid("external_not_enabled", `Solo se pueden exponer a contactos tools habilitadas: ${notEnabled.join(", ")}`);
  }
}
