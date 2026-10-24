// Times are stored and sent in UTC and shown in the owner's display time zone (default IST),
// with UTC in a tooltip (05_UI_Spec section 1).

const SHORT_NAMES: Readonly<Record<string, string>> = {
  'Asia/Kolkata': 'IST',
  'Asia/Calcutta': 'IST',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(timeZone, created);
  return created;
}

/** `IST` for Asia/Kolkata, otherwise the short name Intl gives (`GMT+1`, `EDT`), or the zone id. */
export function zoneLabel(timeZone: string, at: number = Date.now()): string {
  const known = SHORT_NAMES[timeZone];
  if (known) return known;
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

function parts(ms: number, timeZone: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') result[part.type] = part.value;
  }
  return result;
}

/** `11:40 IST`. */
export function formatClock(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  const p = parts(ms, timeZone);
  return `${p.hour ?? '--'}:${p.minute ?? '--'} ${zoneLabel(timeZone, ms)}`;
}

/** `23 Oct 11:40 IST`. */
export function formatDateTime(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  const p = parts(ms, timeZone);
  return `${p.day ?? '--'} ${p.month ?? '---'} ${p.hour ?? '--'}:${p.minute ?? '--'} ${zoneLabel(timeZone, ms)}`;
}

/** `2026-10-23 06:10 UTC`: what the tooltip of every time shows. */
export function formatUtc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `1 h 42 min`, `22 min`, `45 s`. Negative or zero means the moment has passed. */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
  }
  if (total >= 60) return `${String(Math.floor(total / 60))} min`;
  return `${String(total)} s`;
}

/** Like a countdown, with days from 24 hours on: `2 d 3 h`, `1 d`, `5 h 10 min`. For ages and spans that can be long. */
export function formatSpan(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 86_400) return formatCountdown(total);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  return hours === 0 ? `${String(days)} d` : `${String(days)} d ${String(hours)} h`;
}

/** How long a trade lasted, in the same words as a countdown. */
export const formatDuration = formatCountdown;
