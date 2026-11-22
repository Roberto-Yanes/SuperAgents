/** Genera packages/sdk/openapi.json desde los esquemas zod de las rutas (sin levantar el servidor). */
import { MemoryJobPort } from "../src/execution/queue/ports.js";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/shared/config/env.js";
import { createContext } from "../src/container.js";
import { buildApp } from "../src/access/http/app.js";

const config = loadEnv({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost/unused",
  SECRET_KEY: process.env.SECRET_KEY ?? Buffer.alloc(32).toString("base64"),
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "x".repeat(32),
  LOG_LEVEL: "silent",
});
const ctx = createContext(config, { queue: new MemoryJobPort() });
const app = await buildApp(ctx);
await app.ready();
const out = fileURLToPath(new URL("../../../packages/sdk/openapi.json", import.meta.url));
await writeFile(out, JSON.stringify(app.swagger(), null, 2) + "\n");
console.log(`OpenAPI escrito en ${out}`);
await app.close();
await ctx.db.$disconnect();
