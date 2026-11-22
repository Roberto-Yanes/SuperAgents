import type { Db } from "../../data/db.js";
import type { KnowledgeDocument } from "../../data/generated/prisma/client.js";
import { audit, type Actor } from "../../data/audit.js";
import { JOBS, type JobQueue } from "../../execution/queue/jobs.js";
import { invalid, notFound } from "../../shared/errors.js";
import type { FileService } from "../files/service.js";

/** Modelo de embeddings del workspace (ADR 005: proveedor UE). Lo implementa orquestación. */
export interface Embedder {
  /** "<conexión>:<modelo>": las búsquedas vectoriales solo comparan chunks del mismo modelo. */
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderResolver {
  /** null si el workspace no configuró embeddings: la búsqueda usa solo texto completo. */
  forWorkspace(workspaceId: string): Promise<Embedder | null>;
}

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
}

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "text/html", "application/json"]);
export const MAX_DOCUMENT_CHARS = 2_000_000;
const CHUNK_CHARS = 1_000;
const OVERLAP_CHARS = 150;

/**
 * Base de conocimiento del negocio (RAG, capa 1 de la memoria del ADR 003): precios, FAQ, documentos.
 * - Troceado al subir; búsqueda por texto completo de Postgres (sin terceros) y, si el workspace configuró un
 *   modelo de embeddings UE, también vectorial con pgvector, combinadas por fusión de rangos.
 * - Todo filtrado por workspaceId: kb.search nunca ve otro workspace.
 */
export class KnowledgeService {
  constructor(private readonly d: { db: Db; queue: JobQueue; files: Pick<FileService, "read">; embedders: EmbedderResolver }) {}

  async create(workspaceId: string, input: { title: string; text?: string; fileId?: string }, actor: Actor): Promise<KnowledgeDocument> {
    const title = input.title.trim();
    if (!title) throw invalid("title_required", "El título no puede estar vacío");
    let text = input.text;
    let mimeType = "text/plain";
    if (input.fileId) {
      const { file, data } = await this.d.files.read(workspaceId, input.fileId);
      if (!TEXT_TYPES.has(file.mimeType))
        throw invalid("file_type_unsupported", `Tipo no soportado para la base de conocimiento: ${file.mimeType} (usa texto, markdown, CSV, HTML o JSON)`);
      mimeType = file.mimeType;
      text = data.toString("utf8");
    }
    if (!text?.trim()) throw invalid("text_required", "Hace falta texto o un archivo de texto");
    if (text.length > MAX_DOCUMENT_CHARS) throw invalid("document_too_large", "El documento supera 2 millones de caracteres");
    const chunks = chunkText(mimeType === "text/html" ? htmlToText(text) : text);
    const doc = await this.d.db.$transaction(async (tx) => {
      const doc = await tx.knowledgeDocument.create({
        data: {
          workspaceId,
          title,
          source: input.fileId ? "file" : "text",
          mimeType,
          fileId: input.fileId ?? null,
          status: "READY",
          chunkCount: chunks.length,
        },
      });
      await tx.knowledgeChunk.createMany({ data: chunks.map((content, index) => ({ workspaceId, documentId: doc.id, index, content })) });
      return doc;
    });
    await audit(this.d.db, { workspaceId, actor, action: "knowledge.document_created", target: `knowledge:${doc.id}`, data: { chunks: chunks.length } });
    // Embeddings en segundo plano, solo si el workspace tiene modelo de embeddings.
    const embedder = await this.d.embedders.forWorkspace(workspaceId).catch(() => null); // modelo fuera de política: solo texto
    if (embedder) await this.d.queue.send(JOBS.knowledgeIngest, { workspaceId, documentId: doc.id });
    return doc;
  }

  /** Job knowledge.ingest: calcula los embeddings que falten (idempotente). */
  async embedDocument(workspaceId: string, documentId: string): Promise<number> {
    const embedder = await this.d.embedders.forWorkspace(workspaceId);
    if (!embedder) return 0;
    const pending = await this.d.db.$queryRaw<Array<{ id: string; content: string }>>`
      SELECT id, content FROM knowledge_chunk
      WHERE "workspaceId" = ${workspaceId}::uuid AND "documentId" = ${documentId}::uuid
        AND (embedding IS NULL OR "embeddingModel" IS DISTINCT FROM ${embedder.model})
      ORDER BY index`;
    let done = 0;
    for (let i = 0; i < pending.length; i += 32) {
      const batch = pending.slice(i, i + 32);
      const vectors = await embedder.embed(batch.map((c) => c.content));
      for (const [j, c] of batch.entries()) {
        const v = vectors[j];
        if (!v?.length) continue;
        await this.d.db.$executeRaw`UPDATE knowledge_chunk SET embedding = ${toVector(v)}::vector, "embeddingModel" = ${embedder.model}
          WHERE id = ${c.id}::uuid AND "workspaceId" = ${workspaceId}::uuid`;
        done += 1;
      }
    }
    return done;
  }

  list(workspaceId: string) {
    return this.d.db.knowledgeDocument.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  async get(workspaceId: string, id: string): Promise<KnowledgeDocument> {
    const doc = await this.d.db.knowledgeDocument.findFirst({ where: { id, workspaceId } });
    if (!doc) throw notFound("Documento");
    return doc;
  }

  async remove(workspaceId: string, id: string, actor: Actor): Promise<void> {
    await this.get(workspaceId, id);
    await this.d.db.knowledgeDocument.deleteMany({ where: { id, workspaceId } });
    await audit(this.d.db, { workspaceId, actor, action: "knowledge.document_deleted", target: `knowledge:${id}` });
  }

  /** Búsqueda híbrida: texto completo (siempre) + vectorial (si hay embeddings del mismo modelo), fusión RRF. */
  async search(workspaceId: string, query: string, limit = 5): Promise<KnowledgeHit[]> {
    const q = query.trim().slice(0, 500);
    if (!q) return [];
    const n = Math.min(Math.max(limit, 1), 20);
    const text = await this.d.db.$queryRaw<Array<KnowledgeHit>>`
      SELECT c.id AS "chunkId", c."documentId", d.title, c.content,
             ts_rank(to_tsvector('spanish', c.content), qq.q)::float AS score
      FROM knowledge_chunk c
      JOIN knowledge_document d ON d.id = c."documentId" AND d."workspaceId" = c."workspaceId"
      CROSS JOIN LATERAL (
        SELECT to_tsquery('simple', array_to_string(tsvector_to_array(to_tsvector('spanish', ${q})), ' | ')) AS q
      ) qq
      WHERE c."workspaceId" = ${workspaceId}::uuid AND d.status = 'READY'
        AND numnode(qq.q) > 0 AND to_tsvector('spanish', c.content) @@ qq.q
      ORDER BY score DESC
      LIMIT ${n * 2}`;
    let vector: KnowledgeHit[] = [];
    const embedder = await this.d.embedders.forWorkspace(workspaceId).catch(() => null);
    if (embedder) {
      const [v] = await embedder.embed([q]);
      if (v?.length) {
        vector = await this.d.db.$queryRaw<Array<KnowledgeHit>>`
          SELECT c.id AS "chunkId", c."documentId", d.title, c.content, (1 - (c.embedding <=> ${toVector(v)}::vector))::float AS score
          FROM knowledge_chunk c
          JOIN knowledge_document d ON d.id = c."documentId" AND d."workspaceId" = c."workspaceId"
          WHERE c."workspaceId" = ${workspaceId}::uuid AND d.status = 'READY'
            AND c.embedding IS NOT NULL AND c."embeddingModel" = ${embedder.model}
          ORDER BY c.embedding <=> ${toVector(v)}::vector
          LIMIT ${n * 2}`;
      }
    }
    return fuse([text, vector], n);
  }
}

/** Reciprocal Rank Fusion (k = 60): combina listas ordenadas sin calibrar sus puntuaciones. */
export function fuse(lists: KnowledgeHit[][], limit: number): KnowledgeHit[] {
  const byId = new Map<string, { hit: KnowledgeHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const prev = byId.get(hit.chunkId);
      const add = 1 / (60 + rank + 1);
      byId.set(hit.chunkId, { hit: prev?.hit ?? hit, score: (prev?.score ?? 0) + add });
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 1e6) / 1e6 }));
}

/** Trozos de ~1000 caracteres por párrafos, con 150 de solape para no cortar una respuesta por la mitad. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const pieces: string[] = [];
  for (const p of text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    if (p.length <= size) pieces.push(p);
    else for (let i = 0; i < p.length; i += size - overlap) pieces.push(p.slice(i, i + size));
  }
  const out: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + 2 + piece.length > size) {
      out.push(cur);
      const tail = cur.slice(-overlap);
      cur = tail.length + 2 + piece.length <= size ? `${tail}\n\n${piece}` : piece;
    } else {
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n");
}

function toVector(v: number[]): string {
  if (!v.every((x) => Number.isFinite(x))) throw new Error("Embedding inválido");
  return `[${v.join(",")}]`;
}
