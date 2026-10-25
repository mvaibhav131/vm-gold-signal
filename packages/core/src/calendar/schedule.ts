import type { CalendarRecord } from './types';

/** How often the calendar is read when no release is near. */
export const ROUTINE_POLL_MS = 5 * 60_000;
/** How often it is read around a release, to see the released value within seconds. */
export const RELEASE_POLL_MS = 15_000;
/** The fast reading starts this long before a watched event ... */
export const RELEASE_LEAD_MS = 60_000;
/** ... and goes on this long after it while the value has not come. */
export const RELEASE_TAIL_MS = 10 * 60_000;
/** The wait after a failed reading: the first, second, third failure, and then always the last. */
export const FAILURE_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const;
/** The calendar counts as available while its last good reading is no older than this (three missed routine readings). */
export const CALENDAR_MAX_AGE_MS = 15 * 60_000;

type Watched = Pick<CalendarRecord, 'scheduledAt' | 'actual' | 'timeMode'>;

/**
 * The wait until the next reading when the last one worked: the routine interval, shortened so that
 * the fast reading starts on time, and the fast interval from just before a watched event until
 * its released value has come (or the tail has passed). `watch` says which events count.
 */
export function pollDelayMs(
  events: readonly Watched[],
  now: number,
  watch: (event: Watched) => boolean = () => true,
): number {
  let delay = ROUTINE_POLL_MS;
  for (const event of events) {
    if (event.timeMode !== 'exact' || event.actual !== null || !watch(event)) continue;
    const start = event.scheduledAt - RELEASE_LEAD_MS;
    const end = event.scheduledAt + RELEASE_TAIL_MS;
    if (now >= start && now <= end) return RELEASE_POLL_MS;
    if (start > now) delay = Math.min(delay, start - now);
  }
  return Math.max(delay, 1_000);
}

/** The wait after the `failures`-th failure in a row (1 for the first). */
export function failureDelayMs(failures: number): number {
  const index = Math.min(Math.max(Math.trunc(failures), 1), FAILURE_DELAYS_MS.length) - 1;
  return FAILURE_DELAYS_MS[index] ?? 300_000;
}

/** The calendar can be trusted: it was read well within `CALENDAR_MAX_AGE_MS`. Otherwise the news state is UNKNOWN, never CLEAR. */
export function calendarAvailable(
  lastOkAt: number | null,
  now: number,
  maxAgeMs: number = CALENDAR_MAX_AGE_MS,
): boolean {
  return lastOkAt !== null && now - lastOkAt <= maxAgeMs;
}
