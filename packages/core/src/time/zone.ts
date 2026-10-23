// IANA time zone helpers on top of Intl. No fixed offsets anywhere: London and New York change
// their offset on different dates, and the sessions and the trading day follow those zones.

/** A calendar date without a time zone. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface ZonedParts extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday ... 6 = Saturday, in the zone's own calendar. */
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formatters.set(timeZone, created);
  return created;
}

/** The wall clock of `timeZone` at the instant `ms` (epoch milliseconds). */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const fields = new Map<string, number>();
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') fields.set(part.type, Number(part.value));
  }
  const need = (key: string): number => {
    const value = fields.get(key);
    if (value === undefined) throw new Error(`Intl did not return "${key}" for ${timeZone}`);
    return value;
  };
  const year = need('year');
  const month = need('month');
  const day = need('day');
  return {
    year,
    month,
    day,
    hour: need('hour') % 24,
    minute: need('minute'),
    second: need('second'),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Offset of the zone from UTC at the instant `ms`, in milliseconds (New York in summer: -4 h). */
export function utcOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
  );
}

/**
 * The instant at which the zone's wall clock shows `hour:minute` on `date`. Only valid for wall
 * times that exist exactly once. Every time used by the sessions and the trading day does: the
 * zones change their clocks in the night, never at 08:00, 16:30 or 17:00.
 */
export function zonedWallTimeToUtc(
  date: CivilDate,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  const firstGuess = wallAsUtc - utcOffsetMs(wallAsUtc, timeZone);
  return wallAsUtc - utcOffsetMs(firstGuess, timeZone);
}

export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** `2026-10-23`. */
export function formatCivilDate(date: CivilDate): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${String(date.year)}-${two(date.month)}-${two(date.day)}`;
}

/** The UTC calendar date of an instant. */
export function utcCivilDate(ms: number): CivilDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
