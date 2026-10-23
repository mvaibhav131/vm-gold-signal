import { describe, expect, it } from 'vitest';

import { formatClock, formatCountdown, formatDateTime, formatUtc, zoneLabel } from './time';

describe('zoneLabel', () => {
  it('uses IST for Kolkata and UTC for UTC', () => {
    expect(zoneLabel('Asia/Kolkata')).toBe('IST');
    expect(zoneLabel('UTC')).toBe('UTC');
  });

  it('falls back to the short name of the zone', () => {
    expect(zoneLabel('America/New_York', Date.parse('2026-10-23T12:00:00Z'))).toBe('EDT');
    expect(zoneLabel('America/New_York', Date.parse('2026-11-02T12:00:00Z'))).toBe('EST');
  });
});

describe('time in the display zone', () => {
  it('shows 06:10 UTC as 11:40 IST', () => {
    expect(formatClock('2026-10-23T06:10:00Z', 'Asia/Kolkata')).toBe('11:40 IST');
    expect(formatDateTime('2026-10-23T06:10:00Z', 'Asia/Kolkata')).toBe('23 Oct 11:40 IST');
  });

  it('moves to the next day in the display zone', () => {
    expect(formatDateTime('2026-10-23T20:00:00Z', 'Asia/Kolkata')).toBe('24 Oct 01:30 IST');
  });

  it('shows midnight as 00:00, never 24:00', () => {
    expect(formatClock('2026-10-23T04:00:00Z', 'America/New_York')).toBe('00:00 EDT');
  });

  it('writes the UTC time for the tooltip', () => {
    expect(formatUtc('2026-10-23T06:10:45Z')).toBe('2026-10-23 06:10 UTC');
  });
});

describe('formatCountdown', () => {
  it('writes hours and minutes, minutes, then seconds', () => {
    expect(formatCountdown(6120)).toBe('1 h 42 min');
    expect(formatCountdown(7200)).toBe('2 h');
    expect(formatCountdown(1320)).toBe('22 min');
    expect(formatCountdown(59)).toBe('59 s');
  });

  it('never goes below zero', () => {
    expect(formatCountdown(-5)).toBe('0 s');
  });
});
