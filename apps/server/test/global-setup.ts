import { execSync } from "node:child_process";

/**
 * Aplica las migraciones pendientes a la base de tests (no destructivo: migrate deploy).
 * Los tests vacían las tablas con TRUNCATE entre casos (helpers.resetDb).
 * Salvaguarda: solo se ejecuta contra una base cuyo nombre termine en "_test".
 */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/ega_test";
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Los tests solo se ejecutan contra una base *_test (recibido: "${dbName}")`);
  }
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
