import { readdir, readFile, rm, unlink, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from "baileys";
import { decryptJson, encryptJson } from "../../shared/security/crypto.js";

/**
 * Estado de sesión de Baileys CIFRADO en disco (M10). Misma estructura que useMultiFileAuthState de Baileys
 * (un fichero por credencial/clave), pero cada fichero es AES-256-GCM con AAD "baileys:<conexión>:<fichero>":
 * - quien copie el volumen no obtiene la sesión de WhatsApp sin SECRET_KEY;
 * - un fichero movido a otra conexión u otro nombre no descifra.
 * Migración: si encuentra ficheros .json en claro (versiones anteriores), los cifra y borra el original.
 */
export async function useEncryptedFileAuthState(
  folder: string,
  opts: { keys: Buffer[]; connectionId: string },
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  await mkdir(folder, { recursive: true });
  const locks = new Map<string, Promise<unknown>>();
  const fileName = (name: string) => name.replace(/\//g, "__").replace(/:/g, "-");
  const aad = (name: string) => `baileys:${opts.connectionId}:${fileName(name)}`;

  /** Serializa las operaciones sobre un mismo fichero (Baileys lee y escribe en paralelo). */
  const locked = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      name,
      next.catch(() => undefined),
    );
    return next;
  };

  const write = (name: string, data: unknown) =>
    locked(name, async () => {
      const target = path.join(folder, `${fileName(name)}.enc`);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, encryptJson(JSON.stringify(data, BufferJSON.replacer), opts.keys[0]!, aad(name)), { mode: 0o600 });
      await rename(tmp, target); // escritura atómica: una caída no deja un fichero a medias
    });

  const read = (name: string): Promise<unknown> =>
    locked(name, async () => {
      try {
        const blob = await readFile(path.join(folder, `${fileName(name)}.enc`));
        return JSON.parse(decryptJson<string>(blob, opts.keys, aad(name)), BufferJSON.reviver) as unknown;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err; // fichero manipulado o clave incorrecta: no se ignora en silencio
      }
    });

  const remove = (name: string) => locked(name, () => unlink(path.join(folder, `${fileName(name)}.enc`)).catch(() => undefined));

  await migratePlaintext(folder, async (name, data) => write(name, data));

  const creds = ((await read("creds.json")) as AuthenticationState["creds"] | null) ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = (await read(`${type}-${id}.json`)) as SignalDataTypeMap[T] | null;
              if (type === "app-state-sync-key" && value)
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
              if (value) data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const name = `${category}-${id}.json`;
              tasks.push(value ? write(name, value) : remove(name));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write("creds.json", creds),
  };
}

/** Cifra los ficheros .json en claro que dejó useMultiFileAuthState y los borra. */
async function migratePlaintext(folder: string, save: (name: string, data: unknown) => Promise<void>): Promise<void> {
  for (const entry of await readdir(folder)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(folder, entry);
    const data = JSON.parse(await readFile(file, "utf8"), BufferJSON.reviver) as unknown;
    await save(entry, data);
    await rm(file, { force: true });
  }
}
