import type { AppContext } from "../../container.js";
import { JOBS } from "../queue/jobs.js";
import { handleChannelInbound } from "./channel-inbound.js";
import { handleMessageOutbound } from "./message-outbound.js";
import { handleChannelSession } from "./channel-session.js";
import { handleAppointmentReminder } from "./appointment-reminder.js";

export type WorkerDeps = Pick<
  AppContext,
  | "boss"
  | "env"
  | "log"
  | "runtime"
  | "sweeper"
  | "approvals"
  | "connections"
  | "conversations"
  | "channels"
  | "baileys"
  | "bus"
  | "db"
  | "secretKeys"
  | "sequences"
  | "routines"
  | "agenda"
>;

/**
 * Registra los workers de la cola. Siguen sin consumidor: crm.sync e integration.event
 * (triggers de Composio, M9). run.execute y run.resume ya no se registran.
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
  await boss.work(JOBS.sequenceStep, n, async (data) => {
    await deps.sequences.runStep(data.workspaceId, data.enrollmentId, data.step);
  });
  await boss.work(JOBS.routineCron, 1, async (data) => {
    if (data.workspaceId && data.routineId) {
      await deps.routines.fire(data.workspaceId, data.routineId);
      return;
    }
    const fired = await deps.routines.tick();
    if (fired > 0) deps.log.info({ fired }, "rutinas disparadas");
  });
  await boss.boss.schedule(JOBS.routineCron, "* * * * *", {});
  await boss.work(JOBS.appointmentReminder, n, (data) => handleAppointmentReminder(deps, data));

  // Sesiones de WhatsApp por Baileys: este proceso es su dueño (un único worker con sesiones).
  await deps.baileys.startAll();
  deps.log.info({ concurrency: n }, "workers en marcha");
}
