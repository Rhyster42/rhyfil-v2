// Business-day assignment. Mirrors internal/bizdate; both are tested against
// testdata/vectors/business-dates.json (docs/decisions/0013).

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local calendar fields of an instant in a time zone. */
export function localParts(instant: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * The business date of an instant: its calendar date in timeZone, or the
 * previous date if the local time is before cutoffMinutes past midnight.
 */
export function businessDate(instant: Date | string, timeZone: string, cutoffMinutes: number): string {
  const p = localParts(typeof instant === 'string' ? new Date(instant) : instant, timeZone);
  let { year, month, day } = p;
  if (p.hour * 60 + p.minute < cutoffMinutes) {
    const prev = new Date(Date.UTC(year, month - 1, day - 1));
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
