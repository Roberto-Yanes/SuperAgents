import type { AppContext } from "../../container.js";
import type { JOBS, JobPayload } from "../queue/jobs.js";

export type ReminderDeps = Pick<AppContext, "agenda" | "conversations" | "log">;

/** Recordatorio de una cita: si sigue reservada y tiene conversación, sale por el outbox. */
export async function handleAppointmentReminder(ctx: ReminderDeps, data: JobPayload<typeof JOBS.appointmentReminder>): Promise<void> {
  const appt = await ctx.agenda.getAppointment(data.workspaceId, data.appointmentId);
  if (!appt || appt.status !== "BOOKED") return;
  if (appt.startsAt.getTime() < Date.now()) return;
  const when = appt.startsAt.toISOString();
  if (!appt.conversationId) {
    ctx.log.info({ appointmentId: appt.id }, "recordatorio sin conversación");
    return;
  }
  const conv = await ctx.conversations.get(data.workspaceId, appt.conversationId);
  await ctx.conversations.sendOutbound(conv, `Recordatorio: ${appt.title} (${when})`, "SYSTEM", { appointmentId: appt.id });
}
