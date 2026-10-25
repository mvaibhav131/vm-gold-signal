import { describe, expect, it } from 'vitest';
import { feedUptime, tradingMsBetween } from './uptime';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utc = (iso: string): number => Date.parse(`${iso}Z`);

// January 2026: New York is UTC-5, so the weekly closure runs Friday 22:00 UTC to Sunday 22:00 UTC.
const MON = utc('2026-01-05T00:00:00');
const FRI_CLOSE = utc('2026-01-09T22:00:00');
const SUN_OPEN = utc('2026-01-11T22:00:00');

describe('tradingMsBetween', () => {
  it('is the whole span on days in which the market is open', () => {
    expect(tradingMsBetween(MON, MON + 3 * DAY)).toBe(3 * DAY);
  });

  it('is zero for an empty or backwards window', () => {
    expect(tradingMsBetween(MON, MON)).toBe(0);
    expect(tradingMsBetween(MON + DAY, MON)).toBe(0);
  });

  it('leaves out the weekly closure, Friday 17:00 to Sunday 17:00 New York', () => {
    expect(tradingMsBetween(MON, MON + 7 * DAY)).toBe(5 * DAY);
    expect(tradingMsBetween(FRI_CLOSE, SUN_OPEN)).toBe(0);
  });

  it('counts the hours either side of the closure and nothing inside it', () => {
    expect(tradingMsBetween(FRI_CLOSE - HOUR, SUN_OPEN + HOUR)).toBe(2 * HOUR);
    expect(tradingMsBetween(FRI_CLOSE - HOUR, FRI_CLOSE)).toBe(HOUR);
    expect(tradingMsBetween(SUN_OPEN, SUN_OPEN + HOUR)).toBe(HOUR);
  });

  it('is zero for a window that lies inside the closure', () => {
    expect(tradingMsBetween(FRI_CLOSE + HOUR, FRI_CLOSE + 30 * HOUR)).toBe(0);
  });

  it('handles a window that starts inside the closure', () => {
    expect(tradingMsBetween(FRI_CLOSE + DAY, SUN_OPEN + 2 * HOUR)).toBe(2 * HOUR);
    // Sunday 10:00 New York, a day and a half into the closure
    expect(tradingMsBetween(SUN_OPEN - 7 * HOUR, SUN_OPEN + 2 * HOUR)).toBe(2 * HOUR);
  });

  it('handles several weeks', () => {
    expect(tradingMsBetween(MON, MON + 28 * DAY)).toBe(20 * DAY);
  });

  it('follows the clock change of New York (the closure starts at 17:00 local on both sides of it)', () => {
    // Friday 2026-03-06 17:00 EST = 22:00 UTC, Friday 2026-03-13 17:00 EDT = 21:00 UTC
    const monBefore = utc('2026-03-02T00:00:00');
    const fridayAfter = utc('2026-03-13T21:00:00');
    const sundayAfter = utc('2026-03-15T21:00:00');
    expect(tradingMsBetween(fridayAfter - HOUR, sundayAfter + HOUR)).toBe(2 * HOUR);
    expect(tradingMsBetween(monBefore, fridayAfter)).toBe(
      fridayAfter - monBefore - (utc('2026-03-08T21:00:00') - utc('2026-03-06T22:00:00')),
    );
  });
});

describe('feedUptime', () => {
  const week = { from: MON, until: MON + 5 * DAY - 2 * HOUR };

  it('is full uptime with no incident', () => {
    expect(feedUptime([], week.from, week.until)).toEqual({ incidents: 0, uptime: 1 });
  });

  it('is the share of trading time without an incident', () => {
    const total = week.until - week.from;
    const result = feedUptime(
      [{ startedAt: MON + HOUR, endedAt: MON + 2 * HOUR }],
      week.from,
      week.until,
    );
    expect(result.incidents).toBe(1);
    expect(result.uptime).toBeCloseTo(1 - HOUR / total, 12);
  });

  it('counts an overlap of incidents once', () => {
    const total = week.until - week.from;
    const result = feedUptime(
      [
        { startedAt: MON + HOUR, endedAt: MON + 3 * HOUR },
        { startedAt: MON + 2 * HOUR, endedAt: MON + 4 * HOUR },
        { startedAt: MON + 4 * HOUR, endedAt: MON + 5 * HOUR },
      ],
      week.from,
      week.until,
    );
    expect(result.incidents).toBe(3);
    expect(result.uptime).toBeCloseTo(1 - 4 * (HOUR / total), 12);
  });

  it('does not count an incident that sits inside the closure of the market', () => {
    const result = feedUptime(
      [{ startedAt: FRI_CLOSE + HOUR, endedAt: FRI_CLOSE + 20 * HOUR }],
      MON,
      MON + 7 * DAY,
    );
    expect(result.incidents).toBe(1);
    expect(result.uptime).toBe(1);
  });

  it('counts only the part of an incident that is in the window', () => {
    const result = feedUptime(
      [
        { startedAt: MON - 5 * HOUR, endedAt: MON + HOUR },
        { startedAt: MON + 4 * DAY + HOUR, endedAt: MON + 6 * DAY },
      ],
      MON,
      MON + 4 * DAY,
    );
    const total = 4 * DAY;
    expect(result.incidents).toBe(1);
    expect(result.uptime).toBeCloseTo(1 - HOUR / total, 12);
  });

  it('counts an incident that lies inside another one only once, whatever their order', () => {
    const total = week.until - week.from;
    const result = feedUptime(
      [
        { startedAt: MON + HOUR, endedAt: MON + 10 * HOUR },
        { startedAt: MON + 2 * HOUR, endedAt: MON + 3 * HOUR },
      ],
      week.from,
      week.until,
    );
    expect(result.incidents).toBe(2);
    expect(result.uptime).toBeCloseTo(1 - (9 * HOUR) / total, 12);
  });

  it('lets an incident that is still open last to the end of the window', () => {
    const result = feedUptime([{ startedAt: MON + 3 * DAY, endedAt: null }], MON, MON + 4 * DAY);
    expect(result.incidents).toBe(1);
    expect(result.uptime).toBeCloseTo(0.75, 12);
  });

  it('does not count an incident that ended before the window or began after it', () => {
    const result = feedUptime(
      [
        { startedAt: MON - 2 * DAY, endedAt: MON - DAY },
        { startedAt: MON - HOUR, endedAt: MON },
        { startedAt: MON + 4 * DAY, endedAt: MON + 4 * DAY + HOUR },
      ],
      MON,
      MON + 4 * DAY,
    );
    expect(result).toEqual({ incidents: 0, uptime: 1 });
  });

  it('is null when the market was not open at all in the window', () => {
    expect(feedUptime([], FRI_CLOSE + HOUR, SUN_OPEN - HOUR)).toEqual({
      incidents: 0,
      uptime: null,
    });
  });

  it('never goes below zero', () => {
    const result = feedUptime([{ startedAt: MON - DAY, endedAt: null }], MON, MON + 2 * DAY);
    expect(result.uptime).toBe(0);
  });
});
