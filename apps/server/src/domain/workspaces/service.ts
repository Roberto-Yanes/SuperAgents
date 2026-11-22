import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import type { MemberRole } from "../../data/generated/prisma/enums.js";
import { audit, type Actor } from "../../data/audit.js";
import { DomainError, invalid } from "../../shared/errors.js";
import { llmPolicyOf, LlmPolicySchema, type LlmPolicy } from "../connections/llm-residency.js";
import { DEFAULT_RISK_POLICY, loweredRisks, riskPolicyOf, RiskPolicySchema, type RiskPolicy } from "./risk-policy.js";
import { TaskLimitsPatch, type TaskLimitsInput } from "../tasks/limits.js";

/**
 * Políticas del workspace guardadas en Workspace.settings:
 * - riskPolicy (E4): riesgo → directo o aprobación. Solo endurece; bajar send/money a directo exige un OWNER.
 * - llmPolicy (E7): subconjunto de proveedores UE y hosts UE propios.
 * - taskLimits (E3): cupo por defecto de las tareas del workspace (no supera el techo de la plataforma).
 */
export class WorkspacePolicyService {
  constructor(private readonly db: Db) {}

  async get(workspaceId: string): Promise<{ riskPolicy: RiskPolicy; llmPolicy: LlmPolicy; taskLimits: TaskLimitsInput }> {
    const settings = await this.settings(workspaceId);
    return {
      riskPolicy: { ...DEFAULT_RISK_POLICY, ...riskPolicyOf(settings) },
      llmPolicy: llmPolicyOf(settings),
      taskLimits: TaskLimitsPatch.safeParse((settings as { taskLimits?: unknown }).taskLimits ?? {}).data ?? {},
    };
  }

  async setRiskPolicy(workspaceId: string, input: unknown, actor: Actor, role: MemberRole | undefined): Promise<RiskPolicy> {
    const parsed = RiskPolicySchema.safeParse(input);
    if (!parsed.success)
      throw invalid("risk_policy_invalid", "Política de riesgo inválida (delete y write externo no se pueden pasar a directo)", parsed.error.issues);
    const settings = await this.settings(workspaceId);
    const lowered = loweredRisks(parsed.data, riskPolicyOf(settings));
    if (lowered.length > 0 && !(actor.type === "user" && role === "OWNER")) {
      throw new DomainError("forbidden", "owner_required", `Pasar ${lowered.join(" y ")} a directo exige un OWNER`);
    }
    await this.save(workspaceId, settings, { riskPolicy: parsed.data });
    await audit(this.db, {
      workspaceId,
      actor,
      action: "workspace.risk_policy.updated",
      target: `workspace:${workspaceId}`,
      data: { policy: parsed.data, lowered },
    });
    return parsed.data;
  }

  async setLlmPolicy(workspaceId: string, input: unknown, actor: Actor): Promise<LlmPolicy> {
    const parsed = LlmPolicySchema.safeParse(input);
    if (!parsed.success)
      throw invalid("llm_policy_invalid", "Política de modelos inválida: solo proveedores de la lista UE de la plataforma", parsed.error.issues);
    const settings = await this.settings(workspaceId);
    await this.save(workspaceId, settings, { llmPolicy: parsed.data });
    await audit(this.db, { workspaceId, actor, action: "workspace.llm_policy.updated", target: `workspace:${workspaceId}`, data: parsed.data });
    return parsed.data;
  }

  async setTaskLimits(workspaceId: string, input: unknown, actor: Actor): Promise<TaskLimitsInput> {
    const parsed = TaskLimitsPatch.safeParse(input);
    if (!parsed.success) throw invalid("task_limits_invalid", "Cupo inválido", parsed.error.issues);
    const settings = await this.settings(workspaceId);
    await this.save(workspaceId, settings, { taskLimits: parsed.data });
    await audit(this.db, { workspaceId, actor, action: "workspace.task_limits.updated", target: `workspace:${workspaceId}`, data: parsed.data });
    return parsed.data;
  }

  private async settings(workspaceId: string): Promise<Record<string, unknown>> {
    const ws = await this.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    return (ws.settings ?? {}) as Record<string, unknown>;
  }

  private async save(workspaceId: string, prev: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
    await this.db.workspace.update({ where: { id: workspaceId }, data: { settings: { ...prev, ...patch } as Prisma.InputJsonValue } });
  }
}
