import { describe, expect, it } from 'vitest';

import { isWeekendClosure, nextWeekendMidpoint, tradingDayOf } from './tradingDay';

const utc = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

describe('tradingDayOf', () => {
  it('rolls at 17:00 New York in summer (21:00 UTC)', () => {
    const before = tradingDayOf(utc('2026-10-22T20:59:59Z'));
    expect(before.label).toBe('2026-10-22');
    expect(iso(before.startMs)).toBe('2026-10-21T21:00:00.000Z');
    expect(iso(before.endMs)).toBe('2026-10-22T21:00:00.000Z');

    const after = tradingDayOf(utc('2026-10-22T21:00:00Z'));
    expect(after.label).toBe('2026-10-23');
    expect(iso(after.startMs)).toBe('2026-10-22T21:00:00.000Z');
  });

  it('rolls at 22:00 UTC in winter', () => {
    const day = tradingDayOf(utc('2026-11-02T10:00:00Z'));
    expect(day.label).toBe('2026-11-02');
    expect(iso(day.startMs)).toBe('2026-11-01T22:00:00.000Z');
    expect(iso(day.endMs)).toBe('2026-11-02T22:00:00.000Z');
  });

  it('names the day after the date it ends, so Sunday evening belongs to Monday', () => {
    const day = tradingDayOf(utc('2026-10-25T21:30:00Z')); // Sunday 17:30 New York
    expect(day.label).toBe('2026-10-26');
    expect(iso(day.startMs)).toBe('2026-10-25T21:00:00.000Z');
  });

  it('lasts 25 hours on the weekend clocks go back and 23 hours when they go forward', () => {
    const autumn = tradingDayOf(utc('2026-11-01T12:00:00Z'));
    expect(autumn.label).toBe('2026-11-01');
    expect(iso(autumn.startMs)).toBe('2026-10-31T21:00:00.000Z');
    expect(iso(autumn.endMs)).toBe('2026-11-01T22:00:00.000Z');
    expect(autumn.endMs - autumn.startMs).toBe(25 * HOUR);

    const spring = tradingDayOf(utc('2026-03-08T12:00:00Z'));
    expect(iso(spring.startMs)).toBe('2026-03-07T22:00:00.000Z');
    expect(iso(spring.endMs)).toBe('2026-03-08T21:00:00.000Z');
    expect(spring.endMs - spring.startMs).toBe(23 * HOUR);
  });

  it('keeps ordinary weekdays at 24 hours across the DST weeks', () => {
    for (const day of ['2026-03-09', '2026-03-10', '2026-10-30', '2026-11-02', '2026-11-03']) {
      const t = tradingDayOf(utc(`${day}T12:00:00Z`));
      expect(t.endMs - t.startMs).toBe(24 * HOUR);
    }
  });

  it('is continuous: every instant is inside its own day and the next day starts where this one ends', () => {
    let cursor = utc('2026-10-28T00:00:00Z');
    const stop = utc('2026-11-04T00:00:00Z');
    while (cursor < stop) {
      const day = tradingDayOf(cursor);
      expect(cursor).toBeGreaterThanOrEqual(day.startMs);
      expect(cursor).toBeLessThan(day.endMs);
      expect(tradingDayOf(day.endMs).startMs).toBe(day.endMs);
      expect(tradingDayOf(day.endMs - 1).endMs).toBe(day.endMs);
      cursor += 37 * 60_000;
    }
  });
});

describe('isWeekendClosure', () => {
  it('starts at Friday 17:00 New York and ends at Sunday 17:00, to the second (summer time)', () => {
    expect(isWeekendClosure(utc('2026-10-23T20:59:59Z'))).toBe(false);
    expect(isWeekendClosure(utc('2026-10-23T21:00:00Z'))).toBe(true);
    expect(isWeekendClosure(utc('2026-10-24T12:00:00Z'))).toBe(true);
    expect(isWeekendClosure(utc('2026-10-25T20:59:59Z'))).toBe(true);
    expect(isWeekendClosure(utc('2026-10-25T21:00:00Z'))).toBe(false);
  });

  it('follows the clocks of New York: one hour later in winter, and across the weekend they change', () => {
    expect(isWeekendClosure(utc('2026-11-06T21:59:59Z'))).toBe(false);
    expect(isWeekendClosure(utc('2026-11-06T22:00:00Z'))).toBe(true);
    // the clocks go back on Sunday 2026-11-01: the closure from Friday 21:00 UTC lasts until 22:00 UTC
    expect(isWeekendClosure(utc('2026-10-30T20:59:59Z'))).toBe(false);
    expect(isWeekendClosure(utc('2026-10-30T21:00:00Z'))).toBe(true);
    expect(isWeekendClosure(utc('2026-11-01T21:59:59Z'))).toBe(true);
    expect(isWeekendClosure(utc('2026-11-01T22:00:00Z'))).toBe(false);
  });

  it('is open on every weekday hour, also across the daily rollover', () => {
    for (const day of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']) {
      for (let hour = 0; hour < 24; hour += 1) {
        const ms = utc(`${day}T00:00:00Z`) + hour * HOUR;
        expect(isWeekendClosure(ms), iso(ms)).toBe(false);
      }
    }
    expect(isWeekendClosure(utc('2026-10-26T00:00:00Z'))).toBe(false);
  });

  it('agrees with nextWeekendMidpoint: the midpoint of every closure is inside it', () => {
    for (const from of ['2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z', '2026-11-02T00:00:00Z']) {
      expect(isWeekendClosure(nextWeekendMidpoint(utc(from)))).toBe(true);
    }
  });
});

describe('nextWeekendMidpoint', () => {
  it('is Saturday 12:00 New York', () => {
    expect(iso(nextWeekendMidpoint(utc('2026-10-23T20:59:58Z')))).toBe('2026-10-24T16:00:00.000Z');
    expect(iso(nextWeekendMidpoint(utc('2026-11-01T10:00:00Z')))).toBe('2026-11-07T17:00:00.000Z');
  });

  it('is strictly after the given instant', () => {
    const midpoint = utc('2026-10-24T16:00:00Z');
    expect(nextWeekendMidpoint(midpoint)).toBe(utc('2026-10-31T16:00:00Z'));
    expect(nextWeekendMidpoint(midpoint - 1)).toBe(midpoint);
  });
});
