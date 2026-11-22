import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "../domain/files/service.js";

/**
 * Bytes en el disco del servidor (volumen persistente DATA_DIR/files). Escritura atómica (tmp + rename).
 * Solo guarda blobs ya cifrados por FileService. Claves "<workspaceId>/<id>" validadas: sin ".." ni rutas absolutas.
 */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key)) throw new Error("Clave de almacenamiento inválida");
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
