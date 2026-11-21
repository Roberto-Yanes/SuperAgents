import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { actorFrom } from "../../auth/scopes.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { Id, IdParams, iso } from "../schemas.js";

export type ConversationDeps = Pick<AppContext, "conversations">;

const Status = z.enum(["OPEN", "HANDOFF", "CLOSED"]);
const ContactBrief = z.object({ id: Id, name: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable() }).nullable();
const ConversationOut = z.object({
  id: Id,
  agentId: Id,
  contactId: Id.nullable(),
  channel: z.string(),
  connectionId: Id.nullable(),
  status: Status,
  takenOverBy: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
  createdAt: z.string(),
  preview: z.string().nullable(),
  contact: ContactBrief,
});

const Query = z.object({
  status: Status.optional(),
  channel: z.string().max(40).optional(),
  agentId: Id.optional(),
  takenOver: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: Id.optional(),
});

export const conversationRoutes: FastifyPluginAsyncZod<{ deps: ConversationDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/conversations",
    {
      preHandler: requireScopes("chats:read"),
      schema: { tags: ["conversations"], querystring: Query, response: { 200: z.object({ data: z.array(ConversationOut) }) } },
    },
    async (req) => {
      const q = req.query;
      const rows = await deps.conversations.inbox(principalOf(req).workspaceId, {
        ...(q.status ? { status: q.status } : {}),
        ...(q.channel ? { channel: q.channel } : {}),
        ...(q.agentId ? { agentId: q.agentId } : {}),
        ...(q.takenOver ? { takenOver: q.takenOver === "true" } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      });
      return {
        data: rows.map((c) => ({
          id: c.id,
          agentId: c.agentId,
          contactId: c.contactId,
          channel: c.channel,
          connectionId: c.connectionId,
          status: c.status,
          takenOverBy: c.takenOverBy,
          lastInboundAt: iso(c.lastInboundAt),
          createdAt: iso(c.createdAt)!,
          preview: c.messages[0]?.text ?? null,
          contact: c.contact,
        })),
      };
    },
  );

  app.post(
    "/v1/conversations/:id/takeover",
    {
      preHandler: requireScopes("chats:write"),
      schema: { tags: ["conversations"], params: IdParams, response: { 200: z.object({ id: Id, status: Status, takenOverBy: z.string().nullable() }) } },
    },
    async (req) => {
      const p = principalOf(req);
      const conv = await deps.conversations.takeover(p.workspaceId, req.params.id, p.actorId, actorFrom(p));
      return { id: conv.id, status: conv.status, takenOverBy: conv.takenOverBy };
    },
  );

  app.post(
    "/v1/conversations/:id/release",
    {
      preHandler: requireScopes("chats:write"),
      schema: { tags: ["conversations"], params: IdParams, response: { 200: z.object({ id: Id, status: Status, takenOverBy: z.string().nullable() }) } },
    },
    async (req) => {
      const p = principalOf(req);
      const conv = await deps.conversations.release(p.workspaceId, req.params.id, actorFrom(p));
      return { id: conv.id, status: conv.status, takenOverBy: conv.takenOverBy };
    },
  );

  app.post(
    "/v1/conversations/:id/reply",
    {
      preHandler: requireScopes("chats:write"),
      schema: {
        tags: ["conversations"],
        params: IdParams,
        body: z.object({ text: z.string().min(1).max(10_000) }),
        response: { 201: z.object({ id: Id, text: z.string().nullable() }) },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const message = await deps.conversations.replyAsHuman(p.workspaceId, req.params.id, req.body.text, p.actorId);
      return reply.code(201).send({ id: message.id, text: message.text });
    },
  );
};
