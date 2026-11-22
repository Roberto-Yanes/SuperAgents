import { z } from "zod";
import type { ApprovalMode } from "../../data/generated/prisma/enums.js";

/**
 * Política de riesgo por tenant (ADR 003, E4). Va encima de la aprobación declarada por la tool
 * (NEVER / ASK_OWNER / ALWAYS) y del override del agente, y SOLO endurece:
 *
 * | riesgo | por defecto                                   | piso que no se negocia                         |
 * | read   | directo                                       | —                                              |
 * | write  | directo en cara interna, aprobación en externa | la cara externa siempre pide aprobación        |
 * | send   | aprobación                                    | bajarlo a directo exige un OWNER y se audita   |
 * | money  | aprobación                                    | ídem                                           |
 * | delete | aprobación (ALWAYS si la tool lo pide)        | nunca directo                                  |
 */
export const TOOL_RISKS = ["read", "write", "send", "money", "delete"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];
type ToolExposure = "internal" | "external";
const Decision = z.enum(["direct", "approval"]);
export type RiskDecision = z.infer<typeof Decision>;

export const RiskPolicySchema = z
  .object({
    read: Decision.optional(),
    write: z
      .object({ internal: Decision.optional(), external: z.literal("approval").optional() })
      .strict()
      .optional(),
    send: Decision.optional(),
    money: Decision.optional(),
    delete: z.literal("approval").optional(),
  })
  .strict();
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export const DEFAULT_RISK_POLICY = {
  read: "direct",
  write: { internal: "direct", external: "approval" },
  send: "approval",
  money: "approval",
  delete: "approval",
} as const satisfies RiskPolicy;

/** Política del workspace (Workspace.settings.riskPolicy) con los defaults; corrupta = la más estricta. */
export function riskPolicyOf(settings: unknown): RiskPolicy {
  const raw = (settings as { riskPolicy?: unknown } | null)?.riskPolicy;
  const parsed = RiskPolicySchema.safeParse(raw ?? {});
  if (!parsed.success)
    return { read: "approval", write: { internal: "approval", external: "approval" }, send: "approval", money: "approval", delete: "approval" };
  return parsed.data;
}

/**
 * Lo que pide la política para un riesgo en una cara (sin mirar la tool).
 * `nativeExternal`: tool de la plataforma pensada para contactos (memoria del contacto actual, handoff, ficha del
 * contacto). Su escritura solo toca la conversación en curso, así que en la cara externa sigue la regla interna.
 * El piso de aprobación de la cara externa aplica a todo lo demás (tools internas que el dueño expone, apps).
 */
export function policyDecision(policy: RiskPolicy, risk: ToolRisk, face: ToolExposure, nativeExternal = false): RiskDecision {
  switch (risk) {
    case "read":
      return policy.read ?? DEFAULT_RISK_POLICY.read;
    case "write":
      return face === "external" && !nativeExternal ? "approval" : (policy.write?.internal ?? DEFAULT_RISK_POLICY.write.internal);
    case "send":
      return policy.send ?? DEFAULT_RISK_POLICY.send;
    case "money":
      return policy.money ?? DEFAULT_RISK_POLICY.money;
    case "delete":
      return "approval";
  }
}

const RANK: Record<ApprovalMode, number> = { NEVER: 0, ASK_OWNER: 1, ALWAYS: 2 };

/** Modo final de una tool: el más estricto entre el suyo (tool + agente) y el de la política. */
export function applyRiskPolicy(mode: ApprovalMode, risk: ToolRisk, face: ToolExposure, policy: RiskPolicy, nativeExternal = false): ApprovalMode {
  const floor: ApprovalMode = policyDecision(policy, risk, face, nativeExternal) === "approval" ? "ASK_OWNER" : "NEVER";
  return RANK[floor] > RANK[mode] ? floor : mode;
}

/** Cambios de una política que bajan send o money a directo: exigen un OWNER y quedan auditados. */
export function loweredRisks(next: RiskPolicy, prev: RiskPolicy): Array<"send" | "money"> {
  return (["send", "money"] as const).filter((r) => next[r] === "direct" && (prev[r] ?? "approval") !== "direct");
}
