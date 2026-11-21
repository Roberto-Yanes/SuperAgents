import type { AppContext } from "../../container.js";
import type { JobPayload } from "../queue/jobs.js";
import type { JOBS } from "../queue/jobs.js";

export type ChannelSessionDeps = Pick<AppContext, "baileys" | "connections">;

/** Arranque, parada o desvinculación de una sesión de WhatsApp por Baileys. */
export async function handleChannelSession(deps: ChannelSessionDeps, data: JobPayload<typeof JOBS.channelSession>): Promise<void> {
  const conn = await deps.connections.get(data.workspaceId, data.connectionId);
  if (conn.kind !== "channel.whatsapp_baileys") return;
  if (data.action === "start") await deps.baileys.start(conn.id);
  else await deps.baileys.stop(conn.id, { logout: data.action === "logout" });
}
