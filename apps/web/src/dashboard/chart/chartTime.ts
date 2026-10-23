import { TickMarkType, type Time } from 'lightweight-charts';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, key: string, options: Intl.DateTimeFormatOptions) {
  const id = `${timeZone}|${key}`;
  const cached = formatters.get(id);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options });
  formatters.set(id, created);
  return created;
}

function seconds(time: Time): number {
  return typeof time === 'number' ? time : 0;
}

/** Labels on the time axis, in the display time zone. */
export function tickLabel(time: Time, type: TickMarkType, timeZone: string): string {
  const ms = seconds(time) * 1000;
  switch (type) {
    case TickMarkType.Year:
      return formatter(timeZone, 'year', { year: 'numeric' }).format(ms);
    case TickMarkType.Month:
      return formatter(timeZone, 'month', { month: 'short' }).format(ms);
    case TickMarkType.DayOfMonth:
      return formatter(timeZone, 'day', { day: '2-digit', month: 'short' }).format(ms);
    case TickMarkType.Time:
      return formatter(timeZone, 'time', { hour: '2-digit', minute: '2-digit' }).format(ms);
    case TickMarkType.TimeWithSeconds:
      return formatter(timeZone, 'seconds', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(ms);
  }
}

/** The label of the crosshair: date and time. */
export function crosshairLabel(time: Time, timeZone: string): string {
  return formatter(timeZone, 'cross', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(seconds(time) * 1000)
    .replace(',', '');
}
