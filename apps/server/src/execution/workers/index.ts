import type { AppContext } from "../../container.js";
import { JOBS } from "../queue/jobs.js";
import { handleChannelInbound } from "./channel-inbound.js";
import { handleMessageOutbound } from "./message-outbound.js";
import { handleChannelSession } from "./channel-session.js";

export type WorkerDeps = Pick<
  AppContext,
  "boss" | "env" | "log" | "runtime" | "sweeper" | "approvals" | "connections" | "conversations" | "channels" | "baileys" | "bus" | "db" | "secretKeys"
>;

/**
 * Registra los workers de la cola. Los jobs sin implementación todavía (sequence.step, crm.sync,
 * integration.event, appointment.reminder, routine.cron) se añaden con su módulo de dominio.
 */
export async function startWorkers(deps: WorkerDeps): Promise<void> {
  const boss = deps.boss;
  if (!boss) throw new Error("Los workers necesitan pg-boss (BossQueue)");
  const n = deps.env.WORKER_CONCURRENCY;

  // H1: un run a la vez por conversación (grupo = conversationId, coordinado en base de datos entre nodos).
  await boss.work(JOBS.runProcess, { concurrency: n, groupConcurrency: 1 }, (data, meta) => {
    const attempt = meta.retryCount + (data.recover ? 1 : 0);
    return data.kind === "resume" ? deps.runtime.resume(data.workspaceId, data.runId, attempt) : deps.runtime.execute(data.workspaceId, data.runId, attempt);
  });
  // Colas antiguas: solo drenan lo encolado antes de run.process (el claim con lock por conversación las protege).
  await boss.work(JOBS.runExecute, n, (data, meta) => deps.runtime.execute(data.workspaceId, data.runId, meta.retryCount));
  await boss.work(JOBS.runResume, n, (data, meta) => deps.runtime.resume(data.workspaceId, data.runId, meta.retryCount));
  await boss.work(JOBS.runSweep, 1, async () => {
    const r = await deps.sweeper.sweep();
    if (r.recovered + r.requeued + r.resumed + r.failed > 0) deps.log.warn(r, "barrido de runs huérfanos");
  });
  await boss.boss.schedule(JOBS.runSweep, "* * * * *", {});
  await boss.work(JOBS.channelInbound, n, (data) => handleChannelInbound(deps, data));
  await boss.work(JOBS.messageOutbound, n, (data, meta) => handleMessageOutbound(deps, data, meta.retryCount));
  await boss.work(JOBS.channelSession, 1, (data) => handleChannelSession(deps, data));
  await boss.work(JOBS.approvalsExpire, 1, async () => {
    const expired = await deps.approvals.expireDue();
    if (expired > 0) deps.log.info({ expired }, "aprobaciones caducadas");
  });
  await boss.boss.schedule(JOBS.approvalsExpire, "*/5 * * * *", {});

  // Sesiones de WhatsApp por Baileys: este proceso es su dueño (un único worker con sesiones).
  await deps.baileys.startAll();
  deps.log.info({ concurrency: n }, "workers en marcha");
}
