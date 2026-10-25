import { zonedParts } from '../time/zone';

export const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `IST` for Asia/Kolkata, `UTC` for UTC, else the short name that Intl gives for the zone. */
export function zoneName(timeZone: string, at: number): string {
  if (timeZone === 'Asia/Kolkata') return 'IST';
  if (timeZone === 'UTC') return 'UTC';
  const part = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((candidate) => candidate.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

const two = (value: number): string => String(value).padStart(2, '0');

/**
 * A clock time in the display zone: `11:43 IST`. When `reference` is given and the time falls on
 * another day of that zone than the reference, the date follows: `00:15 IST (24 Oct)`.
 */
export function clockText(ms: number, timeZone: string, reference?: number): string {
  if (!Number.isFinite(ms)) throw new RangeError('a time to show must be finite');
  const parts = zonedParts(ms, timeZone);
  const base = `${two(parts.hour)}:${two(parts.minute)} ${zoneName(timeZone, ms)}`;
  if (reference === undefined) return base;
  const other = zonedParts(reference, timeZone);
  if (other.year === parts.year && other.month === parts.month && other.day === parts.day) {
    return base;
  }
  return `${base} (${String(parts.day)} ${SHORT_MONTHS[parts.month - 1] ?? ''})`;
}
