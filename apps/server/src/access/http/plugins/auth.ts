import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AppContext } from "../../../container.js";
import type { Principal, Scope } from "../../auth/scopes.js";
import { forbidden, unauthorized } from "../../../shared/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export type AuthDeps = Pick<AppContext, "principals">;

/** Resuelve el Principal de cada petición (API key o sesión). El workspaceId de la petición sale SIEMPRE de aquí. */
export const authPlugin = fp<{ deps: AuthDeps }>(async (app, { deps }) => {
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (req) => {
    req.principal = await deps.principals.resolve(req.headers);
  });
});

/** preHandler: exige autenticación y todos los scopes indicados. */
export function requireScopes(...scopes: Scope[]): preHandlerHookHandler {
  // Hook síncrono: lanza y Fastify convierte el error en respuesta.
  return (req: FastifyRequest, _reply: FastifyReply, done) => {
    const p = req.principal;
    if (!p) return done(unauthorized());
    const missing = scopes.filter((s) => !p.scopes.has(s));
    if (missing.length > 0) return done(forbidden(`Faltan scopes: ${missing.join(", ")}`));
    done();
  };
}

/** Para handlers: principal garantizado tras requireScopes. */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}
