import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";
import { ChatCreate, ChatOut, IdParams, MessageAccepted, MessageCreate, MessageOut, iso } from "../schemas.js";

export type ChatDeps = Pick<AppContext, "conversations">;

/** Chat desde la UI (flujo A→E del diagrama): POST mensaje → run.process → eventos por SSE/WS. Idempotency-Key: plugin global. */
export const chatRoutes: FastifyPluginAsyncZod<{ deps: ChatDeps }> = async (app, { deps }) => {
  app.post(
    "/v1/chats",
    { preHandler: requireScopes("chats:write"), schema: { tags: ["chats"], body: ChatCreate, response: { 201: ChatOut } } },
    async (req, reply) => {
      const chat = await deps.conversations.createApiChat(principalOf(req).workspaceId, req.body.agentId);
      return reply.code(201).send({ id: chat.id, agentId: chat.agentId, channel: chat.channel, status: chat.status, createdAt: iso(chat.createdAt)! });
    },
  );

  app.post(
    "/v1/chats/:id/messages",
    {
      preHandler: requireScopes("chats:write"),
      schema: {
        tags: ["chats"],
        description: "Envía un mensaje y encola el run del agente. Admite cabecera Idempotency-Key.",
        params: IdParams,
        body: MessageCreate,
        headers: z.object({ "idempotency-key": z.string().optional() }).passthrough(),
        response: { 202: MessageAccepted },
      },
    },
    async (req, reply) => {
      const result = await deps.conversations.receive({
        workspaceId: principalOf(req).workspaceId,
        conversationId: req.params.id,
        text: req.body.text,
        author: "HUMAN",
        trigger: "api.chat",
      });
      return reply.code(202).send({ status: result.status, messageId: result.messageId, runId: result.status === "run_queued" ? result.runId : null });
    },
  );

  app.get(
    "/v1/chats/:id/messages",
    { preHandler: requireScopes("chats:read"), schema: { tags: ["chats"], params: IdParams, response: { 200: z.object({ data: z.array(MessageOut) }) } } },
    async (req) => {
      const rows = await deps.conversations.listMessages(principalOf(req).workspaceId, req.params.id);
      return {
        data: rows.map((m) => ({
          id: m.id,
          direction: m.direction,
          author: m.author,
          text: m.text,
          status: m.status,
          runId: m.runId,
          createdAt: iso(m.createdAt)!,
        })),
      };
    },
  );
};
