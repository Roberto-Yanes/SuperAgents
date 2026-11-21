import type { Db } from "./db.js";

export async function pingDb(db: Db): Promise<boolean> {
  return db.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
}
