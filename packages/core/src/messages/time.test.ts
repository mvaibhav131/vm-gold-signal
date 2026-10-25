import { describe, expect, it } from 'vitest';

import { clockText, zoneName } from './time';

const MORNING = Date.UTC(2026, 9, 23, 6, 8, 0); // 11:38 IST
const MIDNIGHT = Date.UTC(2026, 9, 23, 18, 30, 0); // 00:00 IST on 24 Oct

describe('zoneName', () => {
  it('uses the names that the owner knows for India and UTC', () => {
    expect(zoneName('Asia/Kolkata', MORNING)).toBe('IST');
    expect(zoneName('UTC', MORNING)).toBe('UTC');
  });

  it('asks Intl for any other zone', () => {
    expect(zoneName('Europe/London', Date.UTC(2026, 0, 15))).toBe('GMT');
    expect(zoneName('Europe/London', Date.UTC(2026, 6, 15))).toBe('BST');
  });

  it('refuses a zone that does not exist', () => {
    expect(() => zoneName('Mars/Olympus', MORNING)).toThrow(RangeError);
  });
});

describe('clockText', () => {
  it('writes the wall clock of the display zone with its name', () => {
    expect(clockText(MORNING, 'Asia/Kolkata')).toBe('11:38 IST');
    expect(clockText(MORNING, 'UTC')).toBe('06:08 UTC');
    expect(clockText(Date.UTC(2026, 9, 23, 0, 0, 0), 'UTC')).toBe('00:00 UTC');
    expect(clockText(Date.UTC(2026, 9, 23, 9, 5, 0), 'UTC')).toBe('09:05 UTC');
  });

  it('writes midnight as 00:00', () => {
    expect(clockText(MIDNIGHT, 'Asia/Kolkata')).toBe('00:00 IST');
  });

  it('adds the date only when it is another day than the reference, in the display zone', () => {
    const reference = Date.UTC(2026, 9, 23, 6, 5, 0); // 23 Oct, 11:35 IST
    expect(clockText(MORNING, 'Asia/Kolkata', reference)).toBe('11:38 IST');
    expect(clockText(MIDNIGHT, 'Asia/Kolkata', reference)).toBe('00:00 IST (24 Oct)');
    // the same instant is the same day in UTC
    expect(clockText(MIDNIGHT, 'UTC', reference)).toBe('18:30 UTC');
    expect(clockText(Date.UTC(2026, 10, 2, 6, 0), 'UTC', reference)).toBe('06:00 UTC (2 Nov)');
    expect(clockText(Date.UTC(2027, 0, 5, 6, 0), 'UTC', reference)).toBe('06:00 UTC (5 Jan)');
  });

  it('compares the day in the display zone, not in UTC', () => {
    // 22:00 UTC on the 23rd is 03:30 IST on the 24th; 06:00 UTC on the 23rd is on the 23rd in IST
    const reference = Date.UTC(2026, 9, 23, 6, 0);
    expect(clockText(Date.UTC(2026, 9, 23, 22, 0), 'Asia/Kolkata', reference)).toBe(
      '03:30 IST (24 Oct)',
    );
    const lateReference = Date.UTC(2026, 9, 23, 19, 0); // 00:30 IST on the 24th
    expect(clockText(Date.UTC(2026, 9, 23, 22, 0), 'Asia/Kolkata', lateReference)).toBe(
      '03:30 IST',
    );
  });

  it('refuses a time that is not a number', () => {
    expect(() => clockText(Number.NaN, 'UTC')).toThrow(RangeError);
  });
});
