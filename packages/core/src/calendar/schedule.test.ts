import { describe, expect, it } from 'vitest';

import {
  CALENDAR_MAX_AGE_MS,
  FAILURE_DELAYS_MS,
  RELEASE_LEAD_MS,
  RELEASE_POLL_MS,
  RELEASE_TAIL_MS,
  ROUTINE_POLL_MS,
  calendarAvailable,
  failureDelayMs,
  pollDelayMs,
} from './schedule';

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0);
const MIN = 60_000;

const event = (
  offsetMs: number,
  change: { actual?: number | null; timeMode?: 'exact' | 'tentative' | 'date' } = {},
) => ({
  scheduledAt: NOW + offsetMs,
  actual: change.actual ?? null,
  timeMode: change.timeMode ?? ('exact' as const),
});

describe('the numbers', () => {
  it('are the documented ones', () => {
    expect(ROUTINE_POLL_MS).toBe(5 * MIN);
    expect(RELEASE_POLL_MS).toBe(15_000);
    expect(RELEASE_LEAD_MS).toBe(MIN);
    expect(RELEASE_TAIL_MS).toBe(10 * MIN);
    expect(FAILURE_DELAYS_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(CALENDAR_MAX_AGE_MS).toBe(15 * MIN);
  });
});

describe('pollDelayMs', () => {
  it('is the routine interval when nothing is near', () => {
    expect(pollDelayMs([], NOW)).toBe(ROUTINE_POLL_MS);
    expect(pollDelayMs([event(2 * 60 * MIN)], NOW)).toBe(ROUTINE_POLL_MS);
  });

  it('is shortened so that the fast reading starts a minute before the event', () => {
    expect(pollDelayMs([event(3 * MIN)], NOW)).toBe(2 * MIN);
    expect(pollDelayMs([event(10 * MIN)], NOW)).toBe(5 * MIN);
    expect(pollDelayMs([event(MIN + 30_000)], NOW)).toBe(30_000);
  });

  it('is the fast interval from a minute before the event to ten minutes after it', () => {
    expect(pollDelayMs([event(MIN)], NOW)).toBe(RELEASE_POLL_MS);
    expect(pollDelayMs([event(0)], NOW)).toBe(RELEASE_POLL_MS);
    expect(pollDelayMs([event(-10 * MIN)], NOW)).toBe(RELEASE_POLL_MS);
    expect(pollDelayMs([event(-10 * MIN - 1)], NOW)).toBe(ROUTINE_POLL_MS);
  });

  it('is never shorter than a second', () => {
    expect(pollDelayMs([event(MIN + 1)], NOW)).toBe(1_000);
    expect(pollDelayMs([event(MIN + 500)], NOW)).toBe(1_000);
  });

  it('goes back to the routine interval once the released value is there', () => {
    expect(pollDelayMs([event(-MIN, { actual: 0.5 })], NOW)).toBe(ROUTINE_POLL_MS);
  });

  it('only a time that is exact counts', () => {
    expect(pollDelayMs([event(0, { timeMode: 'tentative' })], NOW)).toBe(ROUTINE_POLL_MS);
    expect(pollDelayMs([event(0, { timeMode: 'date' })], NOW)).toBe(ROUTINE_POLL_MS);
  });

  it('only watched events count', () => {
    const watch = (candidate: { scheduledAt: number }) => candidate.scheduledAt > NOW + 5 * MIN;
    expect(pollDelayMs([event(0), event(2 * MIN)], NOW, watch)).toBe(ROUTINE_POLL_MS);
    expect(pollDelayMs([event(0), event(6 * MIN)], NOW, watch)).toBe(5 * MIN);
  });

  it('takes the nearest of several events, and the fast interval if one is under way', () => {
    expect(pollDelayMs([event(4 * MIN), event(2 * MIN)], NOW)).toBe(MIN);
    expect(pollDelayMs([event(4 * MIN), event(-MIN)], NOW)).toBe(RELEASE_POLL_MS);
  });
});

describe('failureDelayMs', () => {
  it('backs off 30 s, 1 min, 2 min, 5 min and stays at 5 min', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(failureDelayMs)).toEqual([
      30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000,
    ]);
  });

  it('treats a count below one as the first failure', () => {
    expect(failureDelayMs(0)).toBe(30_000);
    expect(failureDelayMs(-3)).toBe(30_000);
    expect(failureDelayMs(2.9)).toBe(60_000);
  });
});

describe('calendarAvailable', () => {
  it('is false when there was no good reading', () => {
    expect(calendarAvailable(null, NOW)).toBe(false);
  });

  it('is true while the last good reading is at most fifteen minutes old', () => {
    expect(calendarAvailable(NOW, NOW)).toBe(true);
    expect(calendarAvailable(NOW - CALENDAR_MAX_AGE_MS, NOW)).toBe(true);
    expect(calendarAvailable(NOW - CALENDAR_MAX_AGE_MS - 1, NOW)).toBe(false);
  });

  it('takes another limit', () => {
    expect(calendarAvailable(NOW - 61_000, NOW, 60_000)).toBe(false);
    expect(calendarAvailable(NOW - 60_000, NOW, 60_000)).toBe(true);
  });
});
