import { z } from "zod";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import type { EventBus } from "../../execution/events/bus.js";
import { JOBS, type JobQueue } from "../../execution/queue/jobs.js";
import { audit, type Actor } from "../../data/audit.js";
import { conflict, invalid, notFound } from "../../shared/errors.js";
import { availableSlots, withinHours, type CalendarRules } from "./availability.js";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const CalendarInput = z.object({
  name: z.string().min(1).max(80),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Zona horaria IANA inválida"),
  slotMinutes: z.number().int().min(5).max(480).default(30),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  minNoticeMinutes: z.number().int().min(0).max(43_200).default(60),
  maxDaysAhead: z.number().int().min(1).max(365).default(30),
  hours: z.partialRecord(z.enum(["1", "2", "3", "4", "5", "6", "7"]), z.array(z.tuple([HHMM, HHMM]))).default({}),
  reminderMinutes: z.number().int().min(0).max(10_080).default(1440),
});
export type CalendarInput = z.infer<typeof CalendarInput>;

export interface BookInput {
  calendarId: string;
  startsAt: Date;
  durationMinutes?: number;
  title: string;
  contactId?: string | null;
  conversationId?: string | null;
  notes?: string;
}

/** Agenda: calendarios con horario local, huecos calculados en código, reservas sin solapes garantizadas por la base de datos. */
export class AgendaService {
  constructor(private readonly d: { db: Db; bus: EventBus; queue: JobQueue; clock?: () => Date }) {}

  private now(): Date {
    return this.d.clock?.() ?? new Date();
  }

  listCalendars(workspaceId: string) {
    return this.d.db.calendar.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  }

  async getCalendar(workspaceId: string, id: string) {
    const cal = await this.d.db.calendar.findFirst({ where: { id, workspaceId } });
    if (!cal) throw notFound("Calendario");
    return cal;
  }

  /** Primer calendario activo (lo usan las tools cuando el agente no indica cuál). */
  async defaultCalendar(workspaceId: string) {
    const cal = await this.d.db.calendar.findFirst({ where: { workspaceId, active: true }, orderBy: { createdAt: "asc" } });
    if (!cal) throw notFound("Calendario");
    return cal;
  }

  async createCalendar(workspaceId: string, input: CalendarInput, actor: Actor) {
    validateHours(input.hours);
    const cal = await this.d.db.calendar.create({ data: { workspaceId, ...input, hours: input.hours as Prisma.InputJsonValue } });
    await audit(this.d.db, { workspaceId, actor, action: "calendar.created", target: `calendar:${cal.id}` });
    return cal;
  }

  async updateCalendar(workspaceId: string, id: string, input: Partial<CalendarInput> & { active?: boolean }, actor: Actor) {
    await this.getCalendar(workspaceId, id);
    if (input.hours) validateHours(input.hours);
    const cal = await this.d.db.calendar.update({ where: { id }, data: { ...input, hours: input.hours as Prisma.InputJsonValue | undefined } });
    await audit(this.d.db, { workspaceId, actor, action: "calendar.updated", target: `calendar:${id}` });
    return cal;
  }

  async slots(workspaceId: string, calendarId: string, range: { from: Date; to: Date }, opts: { durationMinutes?: number; limit?: number } = {}) {
    const cal = await this.getCalendar(workspaceId, calendarId);
    const busy = await this.d.db.appointment.findMany({
      where: { workspaceId, calendarId, status: "BOOKED", startsAt: { lt: range.to }, endsAt: { gt: range.from } },
      select: { startsAt: true, endsAt: true },
    });
    return availableSlots(rulesOf(cal), busy, range, this.now(), opts);
  }

  /**
   * Reserva. Comprueba horario y antelación en código; el no-solape lo garantiza la restricción de exclusión
   * de Postgres (dos reservas simultáneas del mismo hueco: solo una gana).
   */
  async book(workspaceId: string, input: BookInput, actor: Actor) {
    const cal = await this.getCalendar(workspaceId, input.calendarId);
    const duration = input.durationMinutes ?? cal.slotMinutes;
    const rules = rulesOf(cal);
    const now = this.now();
    if (input.startsAt.getTime() < now.getTime() + cal.minNoticeMinutes * 60_000) throw invalid("too_soon", "Ese horario no respeta la antelación mínima");
    if (input.startsAt.getTime() > now.getTime() + cal.maxDaysAhead * 86_400_000) throw invalid("too_far", "Ese horario está fuera del horizonte de reservas");
    if (!withinHours(rules, input.startsAt, duration)) throw invalid("outside_hours", "Ese horario está fuera del horario de atención");
    if (input.contactId) {
      const c = await this.d.db.contact.findFirst({ where: { id: input.contactId, workspaceId }, select: { id: true } });
      if (!c) throw notFound("Contacto");
    }
    const endsAt = new Date(input.startsAt.getTime() + duration * 60_000);
    if (cal.bufferMinutes > 0) {
      const near = await this.d.db.appointment.count({
        where: {
          workspaceId,
          calendarId: cal.id,
          status: "BOOKED",
          startsAt: { lt: new Date(endsAt.getTime() + cal.bufferMinutes * 60_000) },
          endsAt: { gt: new Date(input.startsAt.getTime() - cal.bufferMinutes * 60_000) },
        },
      });
      if (near > 0) throw conflict("slot_taken", "Ese horario ya no está disponible");
    }
    let appt;
    try {
      appt = await this.d.db.appointment.create({
        data: {
          workspaceId,
          calendarId: cal.id,
          contactId: input.contactId ?? null,
          conversationId: input.conversationId ?? null,
          startsAt: input.startsAt,
          endsAt,
          title: input.title,
          notes: input.notes ?? null,
        },
      });
    } catch (err) {
      if (isOverlap(err)) throw conflict("slot_taken", "Ese horario ya no está disponible");
      throw err;
    }
    await audit(this.d.db, { workspaceId, actor, action: "appointment.booked", target: `appointment:${appt.id}` });
    await this.d.bus.publish({
      workspaceId,
      type: "appointment.booked",
      subject: `calendar:${cal.id}`,
      data: { appointmentId: appt.id, startsAt: appt.startsAt.toISOString() },
    });
    const remindAt = appt.startsAt.getTime() - cal.reminderMinutes * 60_000;
    if (cal.reminderMinutes > 0 && remindAt > now.getTime()) {
      await this.d.queue.send(JOBS.appointmentReminder, { workspaceId, appointmentId: appt.id }, { startAfter: new Date(remindAt) });
    }
    return appt;
  }

  getAppointment(workspaceId: string, id: string) {
    return this.d.db.appointment.findFirst({ where: { id, workspaceId } });
  }

  async cancel(workspaceId: string, id: string, actor: Actor, reason?: string) {
    const appt = await this.d.db.appointment.findFirst({ where: { id, workspaceId } });
    if (!appt) throw notFound("Cita");
    if (appt.status !== "BOOKED") throw conflict("appointment_not_booked", `La cita ya está ${appt.status}`);
    const updated = await this.d.db.appointment.update({
      where: { id },
      data: { status: "CANCELLED", notes: reason ? `${appt.notes ?? ""}\nCancelada: ${reason}`.trim() : appt.notes },
    });
    await audit(this.d.db, { workspaceId, actor, action: "appointment.cancelled", target: `appointment:${id}` });
    await this.d.bus.publish({ workspaceId, type: "appointment.cancelled", subject: `calendar:${appt.calendarId}`, data: { appointmentId: id } });
    return updated;
  }

  async setStatus(workspaceId: string, id: string, status: "COMPLETED" | "NO_SHOW", actor: Actor) {
    const appt = await this.d.db.appointment.findFirst({ where: { id, workspaceId } });
    if (!appt) throw notFound("Cita");
    await audit(this.d.db, { workspaceId, actor, action: `appointment.${status.toLowerCase()}`, target: `appointment:${id}` });
    return this.d.db.appointment.update({ where: { id }, data: { status } });
  }

  list(workspaceId: string, q: { calendarId?: string; contactId?: string; from?: Date; to?: Date; status?: "BOOKED" | "CANCELLED" | "COMPLETED" | "NO_SHOW" }) {
    return this.d.db.appointment.findMany({
      where: {
        workspaceId,
        ...(q.calendarId ? { calendarId: q.calendarId } : {}),
        ...(q.contactId ? { contactId: q.contactId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.from || q.to ? { startsAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
      },
      orderBy: { startsAt: "asc" },
      take: 500,
    });
  }

  /** Citas futuras de un contacto (para que el agente pueda confirmarlas o cancelarlas). */
  upcomingForContact(workspaceId: string, contactId: string) {
    return this.d.db.appointment.findMany({
      where: { workspaceId, contactId, status: "BOOKED", startsAt: { gte: this.now() } },
      orderBy: { startsAt: "asc" },
      take: 10,
    });
  }
}

export function rulesOf(cal: {
  timezone: string;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  hours: unknown;
}): CalendarRules {
  return { ...cal, hours: (cal.hours ?? {}) as CalendarRules["hours"] };
}

function validateHours(hours: Partial<Record<string, Array<[string, string]>>>): void {
  for (const [day, ranges = []] of Object.entries(hours)) {
    const sorted = [...ranges].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [i, [open, close]] of sorted.entries()) {
      if (open >= close) throw invalid("invalid_hours", `Día ${day}: ${open}-${close} no es un tramo válido`);
      const next = sorted[i + 1];
      if (next && next[0] < close) throw invalid("invalid_hours", `Día ${day}: los tramos se solapan`);
    }
  }
}

function isOverlap(err: unknown): boolean {
  const text = `${(err as { message?: string })?.message ?? ""} ${JSON.stringify((err as { meta?: unknown })?.meta ?? {})}`;
  return text.includes("appointment_no_overlap") || text.includes("23P01");
}
