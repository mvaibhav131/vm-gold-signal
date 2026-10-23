import { describe, expect, it } from 'vitest';

import {
  addCivilDays,
  formatCivilDate,
  utcCivilDate,
  utcOffsetMs,
  zonedParts,
  zonedWallTimeToUtc,
} from './zone';

const utc = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

describe('zonedParts', () => {
  it('reads the New York wall clock with summer and winter time', () => {
    expect(zonedParts(utc('2026-10-23T12:00:00Z'), 'America/New_York')).toMatchObject({
      year: 2026,
      month: 10,
      day: 23,
      hour: 8,
      minute: 0,
      weekday: 5,
    });
    expect(zonedParts(utc('2026-11-02T12:00:00Z'), 'America/New_York').hour).toBe(7);
  });

  it('shows midnight as hour 0, never 24', () => {
    expect(zonedParts(utc('2026-10-23T04:00:00Z'), 'America/New_York').hour).toBe(0);
    expect(zonedParts(utc('2026-10-23T23:00:00Z'), 'Europe/London').hour).toBe(0);
  });

  it('uses the weekday of the zone, not of UTC', () => {
    // Saturday 01:00 UTC is still Friday evening in New York.
    expect(zonedParts(utc('2026-10-24T01:00:00Z'), 'America/New_York').weekday).toBe(5);
    expect(zonedParts(utc('2026-10-24T01:00:00Z'), 'UTC').weekday).toBe(6);
  });
});

describe('utcOffsetMs', () => {
  it('follows the real daylight saving dates of both zones', () => {
    expect(utcOffsetMs(utc('2026-10-23T12:00:00Z'), 'America/New_York')).toBe(-4 * HOUR);
    expect(utcOffsetMs(utc('2026-11-02T12:00:00Z'), 'America/New_York')).toBe(-5 * HOUR);
    expect(utcOffsetMs(utc('2026-10-24T12:00:00Z'), 'Europe/London')).toBe(HOUR);
    expect(utcOffsetMs(utc('2026-10-26T12:00:00Z'), 'Europe/London')).toBe(0);
  });

  it('switches London at 01:00 UTC on the last Sunday of October', () => {
    expect(utcOffsetMs(utc('2026-10-25T00:59:59Z'), 'Europe/London')).toBe(HOUR);
    expect(utcOffsetMs(utc('2026-10-25T01:00:00Z'), 'Europe/London')).toBe(0);
  });

  it('switches New York at 07:00 UTC (02:00 local) on the first Sunday of November', () => {
    expect(utcOffsetMs(utc('2026-11-01T05:59:59Z'), 'America/New_York')).toBe(-4 * HOUR);
    expect(utcOffsetMs(utc('2026-11-01T06:00:00Z'), 'America/New_York')).toBe(-5 * HOUR);
  });

  it('ignores milliseconds', () => {
    expect(utcOffsetMs(utc('2026-10-23T12:00:00Z') + 999, 'America/New_York')).toBe(-4 * HOUR);
  });
});

describe('zonedWallTimeToUtc', () => {
  const ny = (year: number, month: number, day: number, hour = 17) =>
    new Date(zonedWallTimeToUtc({ year, month, day }, hour, 0, 'America/New_York')).toISOString();
  const london = (year: number, month: number, day: number, hour = 8) =>
    new Date(zonedWallTimeToUtc({ year, month, day }, hour, 0, 'Europe/London')).toISOString();

  it('converts 17:00 New York on both sides of every daylight saving change', () => {
    expect(ny(2026, 3, 6)).toBe('2026-03-06T22:00:00.000Z'); // EST
    expect(ny(2026, 3, 8)).toBe('2026-03-08T21:00:00.000Z'); // the day clocks go forward
    expect(ny(2026, 3, 9)).toBe('2026-03-09T21:00:00.000Z'); // EDT
    expect(ny(2026, 10, 31)).toBe('2026-10-31T21:00:00.000Z'); // EDT
    expect(ny(2026, 11, 1)).toBe('2026-11-01T22:00:00.000Z'); // the day clocks go back
    expect(ny(2026, 11, 2)).toBe('2026-11-02T22:00:00.000Z'); // EST
  });

  it('converts 08:00 London on both sides of the October and March changes', () => {
    expect(london(2026, 3, 28)).toBe('2026-03-28T08:00:00.000Z'); // GMT
    expect(london(2026, 3, 29)).toBe('2026-03-29T07:00:00.000Z'); // BST starts at 01:00 UTC
    expect(london(2026, 10, 24)).toBe('2026-10-24T07:00:00.000Z'); // BST
    expect(london(2026, 10, 25)).toBe('2026-10-25T08:00:00.000Z'); // GMT
  });

  it('round-trips with zonedParts', () => {
    const instant = zonedWallTimeToUtc({ year: 2026, month: 7, day: 15 }, 16, 30, 'Europe/London');
    expect(zonedParts(instant, 'Europe/London')).toMatchObject({ hour: 16, minute: 30, day: 15 });
  });
});

describe('civil dates', () => {
  it('adds days across month and year ends', () => {
    expect(formatCivilDate(addCivilDays({ year: 2026, month: 12, day: 31 }, 1))).toBe('2027-01-01');
    expect(formatCivilDate(addCivilDays({ year: 2026, month: 3, day: 1 }, -1))).toBe('2026-02-28');
    expect(formatCivilDate(addCivilDays({ year: 2028, month: 2, day: 28 }, 1))).toBe('2028-02-29');
  });

  it('reads the UTC date of an instant', () => {
    expect(utcCivilDate(utc('2026-10-23T23:59:59Z'))).toEqual({ year: 2026, month: 10, day: 23 });
  });
});
