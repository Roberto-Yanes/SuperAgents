import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { ContactInput } from "../../../domain/contacts/service.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { Id, IdParams, iso } from "../schemas.js";

export type ContactDeps = Pick<AppContext, "contacts">;

const ContactOut = z.object({
  id: Id,
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
});

const toOut = (c: { id: string; name: string | null; email: string | null; phone: string | null; tags: string[]; createdAt: Date }) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  tags: c.tags,
  createdAt: iso(c.createdAt)!,
});

export const contactRoutes: FastifyPluginAsyncZod<{ deps: ContactDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/contacts",
    {
      preHandler: requireScopes("contacts:read"),
      schema: {
        tags: ["contacts"],
        querystring: z.object({ search: z.string().max(120).optional(), tag: z.string().max(40).optional(), limit: z.coerce.number().int().optional() }),
        response: { 200: z.object({ data: z.array(ContactOut) }) },
      },
    },
    async (req) => {
      const rows = await deps.contacts.list(principalOf(req).workspaceId, req.query);
      return { data: rows.map(toOut) };
    },
  );

  app.post(
    "/v1/contacts",
    { preHandler: requireScopes("contacts:write"), schema: { tags: ["contacts"], body: ContactInput, response: { 201: ContactOut } } },
    async (req, reply) => {
      const p = principalOf(req);
      const contact = await deps.contacts.create(p.workspaceId, req.body, actorFrom(p));
      return reply.code(201).send(toOut(contact));
    },
  );

  app.get(
    "/v1/contacts/:id",
    { preHandler: requireScopes("contacts:read"), schema: { tags: ["contacts"], params: IdParams, response: { 200: ContactOut } } },
    async (req) => toOut(await deps.contacts.get(principalOf(req).workspaceId, req.params.id)),
  );

  app.patch(
    "/v1/contacts/:id",
    { preHandler: requireScopes("contacts:write"), schema: { tags: ["contacts"], params: IdParams, body: ContactInput, response: { 200: ContactOut } } },
    async (req) => {
      const p = principalOf(req);
      return toOut(await deps.contacts.update(p.workspaceId, req.params.id, req.body, actorFrom(p)));
    },
  );

  app.delete(
    "/v1/contacts/:id",
    { preHandler: requireScopes("contacts:write"), schema: { tags: ["contacts"], params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const p = principalOf(req);
      await deps.contacts.remove(p.workspaceId, req.params.id, actorFrom(p));
      return reply.code(204).send(null);
    },
  );
};
