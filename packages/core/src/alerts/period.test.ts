import { describe, expect, it } from 'vitest';

import { dayWindow, monthWindow } from './period';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('dayWindow', () => {
  it('is the Kolkata day around the instant (UTC+5:30)', () => {
    const window = dayWindow(Date.parse('2026-10-23T20:00:00Z'), 'Asia/Kolkata');
    // 01:30 on the 24th in Kolkata: the day is the 24th
    expect(iso(window.from)).toBe('2026-10-23T18:30:00.000Z');
    expect(iso(window.until)).toBe('2026-10-24T18:30:00.000Z');
  });

  it('keeps an instant just before midnight on the same day', () => {
    const window = dayWindow(Date.parse('2026-10-23T18:29:59Z'), 'Asia/Kolkata');
    expect(iso(window.from)).toBe('2026-10-22T18:30:00.000Z');
    expect(iso(window.until)).toBe('2026-10-23T18:30:00.000Z');
  });

  it('is 23 hours long on the day New York starts summer time', () => {
    const window = dayWindow(Date.parse('2026-03-08T15:00:00Z'), 'America/New_York');
    expect(iso(window.from)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(window.until)).toBe('2026-03-09T04:00:00.000Z');
  });

  it('is 25 hours long on the day New York ends summer time', () => {
    const window = dayWindow(Date.parse('2026-11-01T15:00:00Z'), 'America/New_York');
    expect(iso(window.until)).toBe('2026-11-02T05:00:00.000Z');
    expect(window.until - window.from).toBe(25 * 3_600_000);
  });
});

describe('monthWindow', () => {
  it('runs from the first of the month to the first of the next, in the zone', () => {
    const window = monthWindow(Date.parse('2026-10-23T12:00:00Z'), 'Asia/Kolkata');
    expect(iso(window.from)).toBe('2026-09-30T18:30:00.000Z');
    expect(iso(window.until)).toBe('2026-10-31T18:30:00.000Z');
  });

  it('rolls over the year in December', () => {
    const window = monthWindow(Date.parse('2026-12-15T12:00:00Z'), 'UTC');
    expect(iso(window.from)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(window.until)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('puts the last instant of the month in that month and the next one in the next', () => {
    const last = monthWindow(Date.parse('2026-10-31T23:59:59Z'), 'UTC');
    const first = monthWindow(Date.parse('2026-11-01T00:00:00Z'), 'UTC');
    expect(iso(last.from)).toBe('2026-10-01T00:00:00.000Z');
    expect(first.from).toBe(last.until);
  });
});
