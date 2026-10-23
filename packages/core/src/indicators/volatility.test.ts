import { describe, expect, it } from 'vitest';

import { bar, randomBars, round, roundAll, span } from './test-data';
import { computeSeries } from './types';
import {
  Atr,
  Bollinger,
  Choppiness,
  Donchian,
  INDICATOR_DEFAULTS,
  Keltner,
  PercentileRank,
  Squeeze,
  TrueRange,
} from './volatility';

// A short set of candles whose true ranges are easy to follow:
//   1: h 10, l 8,   c 9     TR = 2 (the first candle uses its own range)
//   2: h 11, l 9,   c 10    TR = max(2, |11-9|, |9-9|) = 2
//   3: h 12, l 9.5, c 11    TR = max(2.5, |12-10|, |9.5-10|) = 2.5
//   4: h 11.5, l 10, c 10.5 TR = max(1.5, |11.5-11|, |10-11|) = 1.5
const BARS = [bar(9, 10, 8, 9), bar(9, 11, 9, 10), bar(10, 12, 9.5, 11), bar(11, 11.5, 10, 10.5)];

describe('TrueRange', () => {
  it('uses the previous close, so a gap counts (hand-checked)', () => {
    expect(computeSeries(new TrueRange(), BARS)).toEqual([2, 2, 2.5, 1.5]);
    // A gap up: previous close 10, next candle 14 to 15 -> TR = 5, not 1.
    expect(computeSeries(new TrueRange(), [bar(9, 10, 9, 10), bar(14, 15, 14, 15)])).toEqual([
      1, 5,
    ]);
  });
});

describe('Atr (Wilder)', () => {
  it('starts with the average of the first period true ranges, then smooths (hand-checked)', () => {
    // ATR(3): (2 + 2 + 2.5) / 3 = 2.1666667, then (2.1666667 x 2 + 1.5) / 3 = 1.9444444
    expect(roundAll(computeSeries(new Atr(3), BARS))).toEqual([
      null,
      null,
      2.166666667,
      1.944444444,
    ]);
  });

  it('defaults to a period of 14', () => {
    expect(new Atr().period).toBe(INDICATOR_DEFAULTS.atrPeriod);
    expect(new Atr().warmup).toBe(14);
  });

  it('is zero for candles with no range and no gaps', () => {
    const flat = Array.from({ length: 5 }, () => bar(10, 10, 10, 10));
    expect(computeSeries(new Atr(3), flat)).toEqual([null, null, 0, 0, 0]);
  });
});

describe('Bollinger', () => {
  it('matches the hand calculation for 1..5 (mean 3, population deviation sqrt(2))', () => {
    const [last] = computeSeries(new Bollinger(5, 2), [1, 2, 3, 4, 5]).slice(-1);
    // upper 3 + 2 sqrt 2 = 5.828427, lower 0.171573, bandwidth 5.656854 / 3, %B (5 - .171573) / 5.656854
    expect(round(last?.middle ?? null)).toBe(3);
    expect(round(last?.upper ?? null, 6)).toBe(5.828427);
    expect(round(last?.lower ?? null, 6)).toBe(0.171573);
    expect(round(last?.bandwidth ?? null, 6)).toBe(1.885618);
    expect(round(last?.percentB ?? null, 6)).toBe(0.853553);
  });

  it('has zero width for a constant series and %B of one half', () => {
    const last = computeSeries(new Bollinger(4, 2), [5, 5, 5, 5]).at(-1);
    expect(last).toMatchObject({ middle: 5, upper: 5, lower: 5, bandwidth: 0, percentB: 0.5 });
  });

  it('is null until the window is full, defaults to (20, 2)', () => {
    expect(computeSeries(new Bollinger(3, 2), [1, 2, 3])[1]).toBeNull();
    expect(new Bollinger().warmup).toBe(20);
    expect(new Bollinger().multiplier).toBe(2);
  });
});

describe('Keltner', () => {
  it('is the EMA of the close plus and minus the multiple of the ATR (hand-checked)', () => {
    const values = computeSeries(new Keltner(3, 2, 3), BARS);
    expect(values.slice(0, 2)).toEqual([null, null]);
    // EMA(3) seed (9+10+11)/3 = 10, ATR(3) = 2.1666667 -> 10 +/- 4.3333333
    expect(round(values[2]?.middle ?? null)).toBe(10);
    expect(round(values[2]?.upper ?? null, 6)).toBe(14.333333);
    expect(round(values[2]?.lower ?? null, 6)).toBe(5.666667);
    // next: EMA = 10.5 x .5 + 10 x .5 = 10.25, ATR = 1.9444444 -> upper 10.25 + 3.8888889
    expect(round(values[3]?.upper ?? null, 6)).toBe(14.138889);
  });

  it('uses the ATR(14) of the engine unless told otherwise', () => {
    expect(new Keltner().warmup).toBe(20);
    expect(new Keltner(10, 1.5).warmup).toBe(14);
  });
});

describe('Donchian', () => {
  // highs 5,7,6,8,9,4,3 and lows 3,4,2,5,6,1,2
  const highs = [5, 7, 6, 8, 9, 4, 3];
  const lows = [3, 4, 2, 5, 6, 1, 2];
  const bars = highs.map((h, i) => span(h, lows[i] ?? 0));

  it('follows the highest high and lowest low of the last 3 candles (hand-checked)', () => {
    const values = computeSeries(new Donchian(3), bars);
    expect(values.slice(0, 2)).toEqual([null, null]);
    expect(values.slice(2).map((v) => [v?.upper, v?.lower, v?.middle])).toEqual([
      [7, 2, 4.5],
      [8, 2, 5],
      [9, 2, 5.5],
      [9, 1, 5],
      [9, 1, 5],
    ]);
  });

  it('also gives the channel of the 3 candles before this one, so a breakout never counts itself', () => {
    const values = computeSeries(new Donchian(3), bars);
    expect(values.slice(2).map((v) => [v?.priorUpper, v?.priorLower])).toEqual([
      [null, null],
      [7, 2],
      [8, 2],
      [9, 2],
      [9, 1],
    ]);
  });

  it('defaults to 20', () => {
    expect(new Donchian().period).toBe(20);
  });
});

describe('Choppiness', () => {
  it('is 0 in a perfect trend and 100 in a perfect range (hand-checked)', () => {
    // Trend: every candle 1 high, closing at its high, moving up 1: sum of TR 3, range 3 -> log10(1) = 0
    const trend = [2, 3, 4, 5].map((h) => bar(h, h, h - 1, h));
    const trendValue = computeSeries(new Choppiness(3), trend).at(-1);
    expect(round(trendValue ?? null)).toBe(0);
    // Range: identical candles 1 to 2 closing at 1.5: sum of TR 3, range 1 -> 100 x log10(3) / log10(3)
    const range = Array.from({ length: 4 }, () => bar(1.5, 2, 1, 1.5));
    expect(round(computeSeries(new Choppiness(3), range).at(-1) ?? null)).toBe(100);
  });

  it('counts a window without any range as fully choppy', () => {
    const flat = Array.from({ length: 4 }, () => bar(5, 5, 5, 5));
    expect(computeSeries(new Choppiness(3), flat).at(-1)).toBe(100);
  });

  it('stays between 0 and 100 on random candles', () => {
    for (const value of computeSeries(new Choppiness(14), randomBars(5, 400))) {
      if (value !== null) {
        expect(value).toBeGreaterThanOrEqual(-1e-9);
        expect(value).toBeLessThanOrEqual(100 + 1e-9);
      }
    }
  });
});

describe('PercentileRank', () => {
  it('is the share of the previous values at or below the newest (hand-checked)', () => {
    // window 3: [1,2,3,4] -> previous 1,2,3 all <= 4 -> 100
    expect(computeSeries(new PercentileRank(3), [1, 2, 3, 4])).toEqual([null, null, null, 100]);
    // newest 0 is below all of 1,2,3 -> 0; newest 2 is above 1 and equal to 2 -> 2/3
    expect(computeSeries(new PercentileRank(3), [1, 2, 3, 0])[3]).toBe(0);
    expect(round(computeSeries(new PercentileRank(3), [1, 2, 3, 2])[3] ?? null, 6)).toBe(66.666667);
  });

  it('needs window + 1 inputs', () => {
    expect(new PercentileRank(100).warmup).toBe(101);
  });
});

describe('Squeeze', () => {
  // 30 quiet candles (closes stay within 0.3, candles about 2 high), then a strong move.
  const quiet = Array.from({ length: 30 }, (_, i) => {
    const close = 4000 + (i % 2 === 0 ? 0.15 : -0.15);
    return bar(close, close + 1, close - 1, close);
  });
  const move = Array.from({ length: 6 }, (_, i) => {
    const close = 4000 + (i + 1) * 4;
    return bar(close - 4, close + 0.5, close - 4.5, close);
  });
  const values = computeSeries(new Squeeze(), [...quiet, ...move]);

  it('is on while the bands sit inside the channel, counting its duration', () => {
    const onStreak = values.slice(0, 30);
    expect(onStreak.slice(0, 19).every((v) => v === null)).toBe(true);
    expect(onStreak[19]).toMatchObject({
      on: true,
      duration: 1,
      released: false,
      barsSinceRelease: null,
    });
    expect(onStreak[29]).toMatchObject({ on: true, duration: 11 });
  });

  it('is released once, on the candle where the bands leave the channel, and counts candles since', () => {
    const released = values.map((v, i) => ({ v, i })).filter(({ v }) => v?.released === true);
    expect(released).toHaveLength(1);
    const index = released[0]?.i ?? -1;
    expect(index).toBeGreaterThanOrEqual(30);
    expect(values[index]).toMatchObject({
      on: false,
      duration: 0,
      released: true,
      barsSinceRelease: 0,
    });
    expect(values[index + 1]).toMatchObject({ released: false, barsSinceRelease: 1 });
  });
});
