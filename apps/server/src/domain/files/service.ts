import type { Db } from "../../data/db.js";
import type { StoredFile } from "../../data/generated/prisma/client.js";
import { audit, type Actor } from "../../data/audit.js";
import { invalid, notFound } from "../../shared/errors.js";
import { decryptBytes, encryptBytes, sha256Bytes } from "../../shared/security/crypto.js";

/** Dónde se guardan los bytes (cifrados). Hoy: disco local del servidor (volumen "files"). */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const NAME_RE = /^[^/\\\0]{1,200}$/;
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/i;

/**
 * Archivos del workspace (vault de datos propios): cada archivo se cifra con AES-256-GCM y AAD
 * "file:<workspaceId>:<id>", así un blob copiado a otro archivo u otro workspace no descifra.
 * Los metadatos (nombre, tipo, tamaño, sha256) van en StoredFile; los bytes, en el BlobStore.
 */
export class FileService {
  constructor(private readonly d: { db: Db; store: BlobStore; keys: Buffer[] }) {}

  async upload(workspaceId: string, input: { name: string; mimeType: string; data: Buffer }, actor: Actor): Promise<StoredFile> {
    if (!NAME_RE.test(input.name)) throw invalid("file_name_invalid", "Nombre de archivo inválido");
    if (!MIME_RE.test(input.mimeType)) throw invalid("file_type_invalid", "Tipo de archivo inválido");
    if (input.data.length === 0) throw invalid("file_empty", "El archivo está vacío");
    if (input.data.length > MAX_FILE_BYTES) throw invalid("file_too_large", `El archivo supera ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const id = crypto.randomUUID();
    const storageKey = `${workspaceId}/${id}`;
    await this.d.store.put(storageKey, encryptBytes(input.data, this.d.keys[0]!, aad(workspaceId, id)));
    try {
      const file = await this.d.db.storedFile.create({
        data: {
          id,
          workspaceId,
          name: input.name,
          mimeType: input.mimeType.toLowerCase(),
          size: input.data.length,
          sha256: sha256Bytes(input.data),
          storageKey,
          encrypted: true,
        },
      });
      await audit(this.d.db, { workspaceId, actor, action: "file.uploaded", target: `file:${id}`, data: { size: file.size, mimeType: file.mimeType } });
      return file;
    } catch (err) {
      await this.d.store.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  list(workspaceId: string, q: { cursor?: string; limit?: number } = {}) {
    const take = Math.min(q.limit ?? 50, 100);
    return this.d.db.storedFile
      .findMany({ where: { workspaceId, ...(q.cursor ? { id: { lt: q.cursor } } : {}) }, orderBy: { id: "desc" }, take: take + 1 })
      .then((rows) => ({ data: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null }));
  }

  async get(workspaceId: string, id: string): Promise<StoredFile> {
    const file = await this.d.db.storedFile.findFirst({ where: { id, workspaceId } });
    if (!file) throw notFound("Archivo");
    return file;
  }

  /** Bytes en claro. Verifica integridad (GCM + sha256). */
  async read(workspaceId: string, id: string): Promise<{ file: StoredFile; data: Buffer }> {
    const file = await this.get(workspaceId, id);
    const data = decryptBytes(await this.d.store.get(file.storageKey), this.d.keys, aad(workspaceId, id));
    if (sha256Bytes(data) !== file.sha256) throw new Error("Integridad del archivo comprometida");
    return { file, data };
  }

  async remove(workspaceId: string, id: string, actor: Actor): Promise<void> {
    const file = await this.get(workspaceId, id);
    await this.d.db.storedFile.deleteMany({ where: { id, workspaceId } });
    await this.d.store.delete(file.storageKey).catch(() => undefined);
    await audit(this.d.db, { workspaceId, actor, action: "file.deleted", target: `file:${id}` });
  }
}

/**
 * Recifra todos los archivos con la clave actual (keys[0]) tras rotar SECRET_KEY. Corre con la db de sistema
 * (todos los workspaces). Escribe cada blob de forma atómica; si algo falla, el archivo sigue legible con la clave vieja.
 */
export async function reencryptAllFiles(db: Db, store: BlobStore, keys: Buffer[]): Promise<{ total: number; rewritten: number; failed: number }> {
  const rows = await db.storedFile.findMany({ where: { encrypted: true }, select: { id: true, workspaceId: true, storageKey: true, sha256: true } });
  let rewritten = 0;
  let failed = 0;
  for (const f of rows) {
    try {
      const plain = decryptBytes(await store.get(f.storageKey), keys, aad(f.workspaceId, f.id));
      if (sha256Bytes(plain) !== f.sha256) throw new Error("integridad");
      await store.put(f.storageKey, encryptBytes(plain, keys[0]!, aad(f.workspaceId, f.id)));
      rewritten += 1;
    } catch {
      failed += 1;
    }
  }
  return { total: rows.length, rewritten, failed };
}

function aad(workspaceId: string, id: string): string {
  return `file:${workspaceId}:${id}`;
}
