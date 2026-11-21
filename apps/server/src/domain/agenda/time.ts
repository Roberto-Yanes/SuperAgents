/** Utilidades de zona horaria sin dependencias (Intl). Las fechas se guardan en UTC; las reglas de horario son locales. */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = lunes … 7 = domingo */
  isoWeekday: number;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    isoWeekday: WEEKDAY[parts.weekday!]!,
  };
}

/** Diferencia (minutos) entre la hora local de tz y UTC en ese instante. */
function offsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

/** Hora local (año, mes, día, hh:mm) en tz → instante UTC. Resuelve cambios de horario. */
export function zonedToUtc(year: number, month: number, day: number, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(year, month - 1, day, h, m);
  let ts = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  const second = guess - offsetMinutes(new Date(ts), tz) * 60_000;
  if (second !== ts) ts = second;
  return new Date(ts);
}

export function addDaysLocal(p: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function formatLocal(date: Date, tz: string, locale = "es-ES"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(date);
}
