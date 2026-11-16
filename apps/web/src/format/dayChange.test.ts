import { describe, expect, it } from 'vitest';

import { changedMask, dayChangeOf, nextDirection, signedFixed } from './dayChange';

const HOUR = 3_600_000;
// 2026-11-16 17:00 New York is 22:00 UTC the evening before (EST): the trading day of the morning of the 16th opened at
// 2026-11-15 22:00 UTC
const DAY_START = Date.UTC(2026, 10, 15, 22, 0, 0);
const NOW = Date.UTC(2026, 10, 16, 16, 30, 0);

const candle = (startMs: number, o: number, c: number) => ({
  t: new Date(startMs).toISOString(),
  o,
  c,
});

describe('dayChangeOf', () => {
  it('counts from the open of the first candle of the trading day', () => {
    const candles = [
      candle(DAY_START - HOUR, 3850, 3851),
      candle(DAY_START, 3852, 3853),
      candle(DAY_START + HOUR, 3853, 3860),
    ];
    const result = dayChangeOf(candles, 3864.358, NOW);
    expect(result?.reference).toBe(3852);
    expect(result?.change).toBeCloseTo(12.358, 6);
    expect(result?.pct).toBeCloseTo((12.358 / 3852) * 100, 6);
    expect(result?.sinceMs).toBe(DAY_START);
    expect(result?.partial).toBe(false);
  });

  it('says so when the day was recorded only from a later time', () => {
    const start = Date.UTC(2026, 10, 16, 13, 30, 0);
    const result = dayChangeOf(
      [candle(Date.UTC(2026, 9, 16, 21, 0, 0), 4169, 4170), candle(start, 3857, 3858)],
      3864,
      NOW,
    );
    expect(result?.reference).toBe(3857);
    expect(result?.sinceMs).toBe(start);
    expect(result?.partial).toBe(true);
  });

  it('with no candle of the day yet counts from the last close, if that is recent', () => {
    const lastClose = Date.UTC(2026, 10, 15, 21, 45, 0);
    const result = dayChangeOf([candle(lastClose, 3850, 3855)], 3860, DAY_START + 10 * 60_000);
    expect(result?.reference).toBe(3855);
    expect(result?.change).toBe(5);
    expect(result?.partial).toBe(false);
    // a close from a month ago says nothing about today
    expect(
      dayChangeOf([candle(Date.UTC(2026, 9, 16, 21, 0, 0), 4169, 4170)], 3864, NOW),
    ).toBeNull();
  });

  it('is null without candles', () => {
    expect(dayChangeOf([], 3864, NOW)).toBeNull();
  });

  it('has a negative change when the price is under the reference', () => {
    const result = dayChangeOf([candle(DAY_START, 3900, 3890)], 3864.358, NOW);
    expect(result?.change).toBeCloseTo(-35.642, 6);
    expect(result?.pct).toBeLessThan(0);
  });
});

describe('signedFixed', () => {
  it('always writes the sign, except for zero', () => {
    expect(signedFixed(6.358, 3)).toBe('+6.358');
    expect(signedFixed(-1.25, 3)).toBe('-1.250');
    expect(signedFixed(0, 3)).toBe('0.000');
    expect(signedFixed(-0.0004, 3)).toBe('0.000');
    expect(signedFixed(0.16, 2)).toBe('+0.16');
    expect(signedFixed(-0.004, 2)).toBe('0.00');
  });
});

describe('changedMask', () => {
  it('marks only the characters that differ from the price before', () => {
    expect(changedMask('4000.100', '4000.600')).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(changedMask('5.344', '5.345')).toEqual([false, false, false, false, true]);
    expect(changedMask('5.299', '5.345')).toEqual([false, false, true, true, true]);
  });

  it('marks nothing for the first price and everything when the length changed', () => {
    expect(changedMask(null, '4000.100').some(Boolean)).toBe(false);
    expect(changedMask('999.999', '1000.000').every(Boolean)).toBe(true);
    expect(changedMask('4000.100', '4000.100').some(Boolean)).toBe(false);
  });
});

describe('nextDirection', () => {
  it('follows the last move and keeps it while the price stands still', () => {
    expect(nextDirection(10, 11, 'flat')).toBe('up');
    expect(nextDirection(11, 10, 'up')).toBe('down');
    expect(nextDirection(10, 10, 'down')).toBe('down');
    expect(nextDirection(10, 10, 'flat')).toBe('flat');
  });

  it('is flat for the first price', () => {
    expect(nextDirection(null, 10, 'up')).toBe('flat');
    expect(nextDirection(10, null, 'up')).toBe('flat');
  });
});
