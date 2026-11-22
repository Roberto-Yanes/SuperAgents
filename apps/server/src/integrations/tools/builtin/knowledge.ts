import { z } from "zod";
import type { KnowledgeService } from "../../../domain/knowledge/service.js";
import { defineTool, type ToolDef } from "../types.js";

/**
 * kb.search: lectura de la base de conocimiento del negocio (precios, FAQ, documentos).
 * Las dos caras la pueden usar en modo lectura (ADR 003, memoria capa 1); solo ve el workspace del run.
 */
export function knowledgeTools(knowledge: Pick<KnowledgeService, "search">): ToolDef[] {
  const search = defineTool({
    name: "kb.search",
    description: "Busca en la base de conocimiento del negocio (precios, servicios, horarios, políticas, FAQ). Úsala antes de responder datos del negocio.",
    input: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(8).optional() }),
    scope: "knowledge:read",
    risk: "read",
    exposure: "external", // lectura de información del negocio pensada para responder a clientes
    approval: "NEVER",
    async execute(input, ctx) {
      const hits = await knowledge.search(ctx.workspaceId, input.query, input.limit ?? 4);
      if (!hits.length) return { ok: true, results: [], note: "No hay información sobre eso en la base de conocimiento. No la inventes." };
      return { ok: true, results: hits.map((h) => ({ document: h.title, text: h.content })) };
    },
  });
  return [search] as ToolDef[];
}
