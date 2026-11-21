import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { hashPassword } from "better-auth/crypto";
import type { Db } from "../../data/db.js";
import type { MemberRole } from "../../data/generated/prisma/enums.js";

/** Sesiones de usuario (UI). Las integraciones usan API keys (ver http/plugins/auth.ts). */
export function createAuth(db: Db, opts: { secret: string; baseURL: string; trustedOrigins: string[]; allowSignUp?: boolean }) {
  return betterAuth({
    database: prismaAdapter(db, { provider: "postgresql" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    basePath: "/api/auth",
    trustedOrigins: opts.trustedOrigins,
    // M3: sin alta pública salvo AUTH_SIGNUP=enabled. Un usuario sin membresía no ve nada, pero tampoco debe poder crearse.
    emailAndPassword: { enabled: true, autoSignIn: true, disableSignUp: !opts.allowSignUp, minPasswordLength: 12 },
    advanced: { database: { generateId: () => crypto.randomUUID() } },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Alta de un usuario con contraseña y su membresía en un workspace (CLI add-user). Mismo formato que Better Auth
 * (cuenta "credential" con hash scrypt), así puede iniciar sesión por /api/auth/sign-in/email.
 */
export async function createUserWithPassword(
  db: Db,
  input: { email: string; name: string; password: string; workspaceId: string; role: MemberRole },
): Promise<{ userId: string; created: boolean }> {
  if (input.password.length < 12) throw new Error("La contraseña debe tener al menos 12 caracteres");
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  const userId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    const password = await hashPassword(input.password);
    await db.$transaction([
      db.user.create({ data: { id: userId, email, name: input.name, emailVerified: true } }),
      db.account.create({ data: { id: crypto.randomUUID(), accountId: userId, providerId: "credential", userId, password } }),
    ]);
  }
  await db.membership.upsert({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId } },
    update: { role: input.role },
    create: { workspaceId: input.workspaceId, userId, role: input.role },
  });
  return { userId, created: !existing };
}
