/**
 * CLI de operación.
 *   node dist/cli.js bootstrap --name "Mi negocio" --slug mi-negocio [--tz Europe/Madrid]
 *     Crea un workspace y una API key con todos los scopes (se muestra una sola vez).
 *   node dist/cli.js add-user --workspace mi-negocio --email ana@x.com --name "Ana" [--role OWNER|ADMIN|OPERATOR] [--password ...]
 *     Crea el usuario (o reutiliza el existente) y le da acceso al workspace. Sin --password genera una y la muestra una vez.
 *     El alta pública está cerrada por defecto (AUTH_SIGNUP=disabled).
 *   node dist/cli.js rotate-secrets
 *     Recifra los secretos de todas las conexiones con SECRET_KEY (acepta los cifrados con SECRET_KEY_OLD y el
 *     formato antiguo sin AAD). Pasos: nueva clave en SECRET_KEY, la vieja en SECRET_KEY_OLD, ejecutar, quitar la vieja.
 */
import { parseArgs } from "node:util";
import { env } from "./shared/config/env.js";
import { createDb } from "./data/db.js";
import { ApiKeyService } from "./access/auth/api-keys.js";
import { SCOPES } from "./access/auth/scopes.js";
import { createUserWithPassword } from "./access/auth/better-auth.js";
import { reencryptAllSecrets } from "./domain/connections/service.js";
import { randomToken } from "./shared/security/crypto.js";

async function bootstrap(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { name: { type: "string" }, slug: { type: "string" }, tz: { type: "string", default: "Europe/Madrid" } } });
  if (!values.name || !values.slug) throw new Error('Uso: bootstrap --name "Mi negocio" --slug mi-negocio [--tz Europe/Madrid]');
  const db = createDb(env().DATABASE_URL);
  try {
    const workspace = await db.workspace.create({ data: { name: values.name, slug: values.slug, timezone: values.tz! } });
    const key = await new ApiKeyService(db).issue({ workspaceId: workspace.id, name: "bootstrap", scopes: [...SCOPES] });
    console.log(JSON.stringify({ workspaceId: workspace.id, apiKey: key.token }, null, 2));
    console.log("Guarda la API key: no se vuelve a mostrar.");
  } finally {
    await db.$disconnect();
  }
}

async function addUser(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "OWNER" },
      password: { type: "string" },
    },
  });
  if (!values.workspace || !values.email || !values.name)
    throw new Error('Uso: add-user --workspace <slug> --email <email> --name "Nombre" [--role OWNER|ADMIN|OPERATOR] [--password ...]');
  const role = values.role as "OWNER" | "ADMIN" | "OPERATOR";
  if (!["OWNER", "ADMIN", "OPERATOR"].includes(role)) throw new Error("--role debe ser OWNER, ADMIN u OPERATOR");
  const db = createDb(env().DATABASE_URL);
  try {
    const workspace = await db.workspace.findUnique({ where: { slug: values.workspace } });
    if (!workspace) throw new Error(`No existe el workspace ${values.workspace}`);
    const password = values.password ?? randomToken(18);
    const r = await createUserWithPassword(db, { email: values.email, name: values.name, password, workspaceId: workspace.id, role });
    console.log(JSON.stringify({ userId: r.userId, workspaceId: workspace.id, role, ...(r.created && !values.password ? { password } : {}) }, null, 2));
    if (!r.created) console.log("El usuario ya existía: se actualizó su acceso (la contraseña no cambia).");
    else if (!values.password) console.log("Guarda la contraseña: no se vuelve a mostrar.");
  } finally {
    await db.$disconnect();
  }
}

async function rotateSecrets(): Promise<void> {
  const config = env();
  const keys = [config.SECRET_KEY, config.SECRET_KEY_OLD].filter((k): k is string => Boolean(k)).map((k) => Buffer.from(k, "base64"));
  const db = createDb(config.DATABASE_URL);
  try {
    console.log(JSON.stringify(await reencryptAllSecrets(db, keys)));
    if (config.SECRET_KEY_OLD) console.log("Listo. Ya puedes quitar SECRET_KEY_OLD y reiniciar.");
  } finally {
    await db.$disconnect();
  }
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = { bootstrap, "add-user": addUser, "rotate-secrets": rotateSecrets };
const run = command ? commands[command] : undefined;
if (!run) {
  console.error(`Comandos: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
run(rest).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
