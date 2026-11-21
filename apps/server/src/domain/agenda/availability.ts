import { addDaysLocal, localParts, zonedToUtc } from "./time.js";

export interface CalendarRules {
  timezone: string;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  /** { "1": [["09:00","14:00"]], ... } con 1 = lunes */
  hours: Record<string, Array<[string, string]>>;
}

export interface Busy {
  startsAt: Date;
  endsAt: Date;
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

const MIN = 60_000;

/**
 * Huecos libres calculados en código (nunca por el modelo): horario local del calendario
 * − citas ocupadas (con margen) − antelación mínima, dentro del horizonte permitido.
 */
export function availableSlots(
  rules: CalendarRules,
  busy: Busy[],
  range: { from: Date; to: Date },
  now: Date,
  opts: { durationMinutes?: number; limit?: number } = {},
): Slot[] {
  const duration = (opts.durationMinutes ?? rules.slotMinutes) * MIN;
  const step = rules.slotMinutes * MIN;
  const earliest = Math.max(range.from.getTime(), now.getTime() + rules.minNoticeMinutes * MIN);
  const latest = Math.min(range.to.getTime(), now.getTime() + rules.maxDaysAhead * 24 * 60 * MIN);
  const limit = opts.limit ?? 50;
  const buffer = rules.bufferMinutes * MIN;
  const blocked = busy.map((b) => ({ s: b.startsAt.getTime() - buffer, e: b.endsAt.getTime() + buffer }));
  const slots: Slot[] = [];
  if (latest <= earliest) return slots;

  const startDay = localParts(new Date(earliest), rules.timezone);
  for (let i = 0; i <= rules.maxDaysAhead + 1 && slots.length < limit; i++) {
    const day = addDaysLocal(startDay, i);
    const weekday = ((new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() + 6) % 7) + 1;
    for (const [open, close] of rules.hours[String(weekday)] ?? []) {
      const openAt = zonedToUtc(day.year, day.month, day.day, open, rules.timezone).getTime();
      const closeAt = zonedToUtc(day.year, day.month, day.day, close, rules.timezone).getTime();
      for (let s = openAt; s + duration <= closeAt; s += step) {
        const e = s + duration;
        if (s < earliest || e > latest) continue;
        if (blocked.some((b) => s < b.e && e > b.s)) continue;
        slots.push({ startsAt: new Date(s), endsAt: new Date(e) });
        if (slots.length >= limit) break;
      }
      if (slots.length >= limit) break;
    }
    if (zonedToUtc(day.year, day.month, day.day, "00:00", rules.timezone).getTime() > latest) break;
  }
  return slots;
}

/** ¿Encaja [start, start+duración) dentro del horario de ese día local? */
export function withinHours(rules: CalendarRules, start: Date, durationMinutes: number): boolean {
  const p = localParts(start, rules.timezone);
  const end = start.getTime() + durationMinutes * MIN;
  return (rules.hours[String(p.isoWeekday)] ?? []).some(([open, close]) => {
    const o = zonedToUtc(p.year, p.month, p.day, open, rules.timezone).getTime();
    const c = zonedToUtc(p.year, p.month, p.day, close, rules.timezone).getTime();
    return start.getTime() >= o && end <= c;
  });
}
