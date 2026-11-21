import type { ApprovalMode } from "../../data/generated/prisma/enums.js";
import type { ToolDef, ToolExposure } from "./types.js";

export interface AgentToolConfig {
  /** Tools habilitadas para el agente. Si una tool no está aquí, el agente no la ve. */
  tools?: string[];
  /** Overrides de aprobación por tool. Solo pueden relajar ASK_OWNER → NEVER o endurecer. */
  approvals?: Record<string, ApprovalMode>;
  /**
   * Tools internas que el dueño autoriza TAMBIÉN en conversaciones con contactos (cara externa).
   * Si no son de solo lectura, en la cara externa piden al menos ASK_OWNER (no se puede relajar).
   */
  external?: string[];
}

export interface ResolvedTool {
  def: ToolDef;
  mode: ApprovalMode;
}

/**
 * Proveedor de tools que dependen del workspace (p. ej. acciones de Composio habilitadas por cada cliente).
 * Abierto/cerrado: un proveedor nuevo se registra sin tocar el runtime.
 */
export interface ToolProvider {
  /** Prefijo de los nombres que aporta, p. ej. "composio." */
  readonly prefix: string;
  toolsForWorkspace(workspaceId: string): Promise<ToolDef[]>;
}

/** Lo que el runtime y los servicios necesitan del catálogo de tools. */
export interface ToolCatalog {
  resolveForAgent(workspaceId: string, config: AgentToolConfig, face?: ToolExposure): Promise<ResolvedTool[]>;
  resolve(workspaceId: string, name: string): Promise<ToolDef | undefined>;
  unknownNames(workspaceId: string, names: string[]): Promise<string[]>;
  listForWorkspace(workspaceId: string): Promise<ToolDef[]>;
}

const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export class ToolRegistry implements ToolCatalog {
  private readonly defs = new Map<string, ToolDef>();
  private readonly providers: ToolProvider[] = [];

  register(def: ToolDef): this {
    if (!NAME.test(def.name)) throw new Error(`Nombre de tool inválido: ${def.name}`);
    if (this.defs.has(def.name)) throw new Error(`Tool duplicada: ${def.name}`);
    this.defs.set(def.name, def);
    return this;
  }

  addProvider(provider: ToolProvider): this {
    this.providers.push(provider);
    return this;
  }

  get(name: string): ToolDef | undefined {
    return this.defs.get(name);
  }

  list(): ToolDef[] {
    return [...this.defs.values()];
  }

  async resolve(workspaceId: string, name: string): Promise<ToolDef | undefined> {
    const local = this.defs.get(name);
    if (local) return local;
    const provider = this.providers.find((p) => name.startsWith(p.prefix));
    if (!provider) return undefined;
    return (await provider.toolsForWorkspace(workspaceId)).find((d) => d.name === name);
  }

  /** Tools visibles para un agente, con su modo de aprobación efectivo. */
  async resolveForAgent(workspaceId: string, config: AgentToolConfig, face: ToolExposure = "internal"): Promise<ResolvedTool[]> {
    const enabled = config.tools ?? [];
    const needed = this.providers.filter((p) => enabled.some((n) => n.startsWith(p.prefix)));
    const dynamic = new Map<string, ToolDef>();
    for (const p of needed) for (const d of await p.toolsForWorkspace(workspaceId)) dynamic.set(d.name, d);
    return enabled.flatMap((name) => {
      const def = this.defs.get(name) ?? dynamic.get(name);
      if (!def) return [];
      const mode = effectiveApproval(def.approval, config.approvals?.[name]);
      if (face === "internal" || exposureOf(def) === "external") return [{ def, mode }];
      if (!config.external?.includes(name)) return []; // tool interna: invisible para contactos
      return [{ def, mode: def.risk === "read" ? mode : effectiveApproval(mode, "ASK_OWNER") }];
    });
  }

  /** Catálogo completo disponible para un workspace (tools del sistema + las de sus proveedores). */
  async listForWorkspace(workspaceId: string): Promise<ToolDef[]> {
    const dynamic = (await Promise.all(this.providers.map((p) => p.toolsForWorkspace(workspaceId).catch(() => [])))).flat();
    return [...this.defs.values(), ...dynamic];
  }

  async unknownNames(workspaceId: string, names: string[]): Promise<string[]> {
    const unknown: string[] = [];
    for (const n of names) if (!(await this.resolve(workspaceId, n))) unknown.push(n);
    return unknown;
  }
}

const RANK: Record<ApprovalMode, number> = { NEVER: 0, ASK_OWNER: 1, ALWAYS: 2 };

/**
 * Reglas:
 * - ALWAYS en la definición no se puede relajar.
 * - Un override puede endurecer cualquier modo.
 * - Un override solo puede relajar ASK_OWNER → NEVER.
 */
export function exposureOf(def: ToolDef): ToolExposure {
  return def.exposure ?? "internal";
}

export function effectiveApproval(base: ApprovalMode, override?: ApprovalMode): ApprovalMode {
  if (!override) return base;
  if (base === "ALWAYS") return "ALWAYS";
  if (RANK[override] >= RANK[base]) return override;
  return base === "ASK_OWNER" && override === "NEVER" ? "NEVER" : base;
}

/** No todos los proveedores aceptan puntos en nombres de tool: "memory.save" → "memory__save". */
export const toModelToolName = (name: string) => name.replaceAll(".", "__");
export const fromModelToolName = (name: string) => name.replaceAll("__", ".");
