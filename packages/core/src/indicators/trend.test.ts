import { describe, expect, it } from 'vitest';

import { bar, randomBars, round, span } from './test-data';
import {
  Aroon,
  EfficiencyRatio,
  HeikinAshi,
  LinearRegression,
  ParabolicSar,
  Supertrend,
} from './trend';
import { computeSeries } from './types';

describe('Supertrend', () => {
  // period 2, multiplier 1; the numbers were worked out by hand step by step:
  //  1: TR 2.                          2: TR 2, ATR 2, mid 11 -> bands 13 / 9, close 11.5 >= 11 -> UP, line 9
  //  3: mid 12, bands 14 / 10: upper stays 13, lower rises to 10 -> UP, line 10
  //  4: crash: TR 4.8, ATR 3.4, close 8.5 < lower 10 -> DOWN, line = upper 13 (flipped)
  //  5: TR 1.5, ATR 2.45, mid 8.25: upper falls to 10.7 -> DOWN, line 10.7
  const bars = [
    bar(10, 11, 9, 10.5),
    bar(10.5, 12, 10, 11.5),
    bar(12.8, 13, 11, 12.8),
    bar(12.5, 12.5, 8, 8.5),
    bar(8.5, 9, 7.5, 7.8),
  ];

  it('trails the price and flips when the close crosses the band (hand-checked)', () => {
    const values = computeSeries(new Supertrend(2, 1), bars);
    expect(values[0]).toBeNull();
    expect(
      values.slice(1).map((v) => [round(v?.value ?? null, 6), v?.direction, v?.flipped]),
    ).toEqual([
      [9, 'UP', false],
      [10, 'UP', false],
      [13, 'DOWN', true],
      [10.7, 'DOWN', false],
    ]);
    expect(round(values[4]?.lower ?? null, 6)).toBe(5.8);
  });

  it('has its first value when the ATR exists, and the trailing band of an uptrend never falls', () => {
    const rising = Array.from({ length: 60 }, (_, i) => bar(100 + i, 101.5 + i, 99.5 + i, 101 + i));
    const indicator = new Supertrend(10, 3);
    const values = computeSeries(indicator, rising);
    expect(indicator.warmup).toBe(10);
    expect(values.findIndex((v) => v !== null)).toBe(9);
    const lines = values.filter((v) => v !== null).map((v) => v.value);
    expect(values.filter((v) => v !== null).every((v) => v.direction === 'UP')).toBe(true);
    expect(lines.every((line, i) => i === 0 || line >= (lines[i - 1] ?? 0))).toBe(true);
    expect(lines.at(-1)).toBeLessThan(rising.at(-1)?.c ?? 0);
  });

  it('defaults to (10, 3)', () => {
    expect(new Supertrend().multiplier).toBe(3);
    expect(new Supertrend().period).toBe(10);
  });
});

describe('ParabolicSar', () => {
  // Worked out by hand (step 0.02, max 0.2):
  //  2: long, SAR starts at the first low 8, extreme 11
  //  3: 8 + .02 x 3 = 8.06, held down to the lower of the last two lows (8) -> 8, extreme 12, AF .04
  //  4: 8 + .04 x 4 = 8.16 -> 8.16, extreme 13, AF .06
  //  5: 8.16 + .06 x 4.84 = 8.4504, but the low 7 is below it: reversal, SAR = extreme 13, AF back to .02
  //  6: short: 13 - .02 x 6 = 12.88, held up to the higher of the last two highs (13) -> 13
  const bars = [
    bar(9, 10, 8, 9),
    bar(9, 11, 9, 10.5),
    bar(10.5, 12, 10, 11.5),
    bar(11.5, 13, 11, 12.5),
    bar(12.5, 12, 7, 7.5),
    bar(7.5, 8, 6, 6.5),
  ];

  it('accelerates under a trend and reverses when the price touches it (hand-checked)', () => {
    const values = computeSeries(new ParabolicSar(), bars);
    expect(values[0]).toBeNull();
    expect(
      values.slice(1).map((v) => [round(v?.sar ?? null, 6), v?.direction, v?.reversed]),
    ).toEqual([
      [8, 'UP', false],
      [8, 'UP', false],
      [8.16, 'UP', false],
      [13, 'DOWN', true],
      [13, 'DOWN', false],
    ]);
    expect(values.slice(1).map((v) => v?.accelerationFactor)).toEqual([
      0.02, 0.04, 0.06, 0.02, 0.04,
    ]);
    expect(values.slice(1).map((v) => v?.extremePoint)).toEqual([11, 12, 13, 7, 6]);
  });

  it('caps the acceleration factor at the maximum', () => {
    const rising = Array.from({ length: 40 }, (_, i) => bar(100 + i, 101 + i, 99.5 + i, 100.8 + i));
    const last = computeSeries(new ParabolicSar(0.02, 0.2), rising).at(-1);
    expect(last?.accelerationFactor).toBeCloseTo(0.2, 12);
    expect(last?.direction).toBe('UP');
  });

  it('starts down when the second candle closes lower', () => {
    const first = computeSeries(new ParabolicSar(), [bar(10, 12, 9, 11), bar(11, 11.5, 8, 9)])[1];
    expect(first).toMatchObject({ direction: 'DOWN', sar: 12, extremePoint: 8 });
  });

  it('rejects impossible settings', () => {
    expect(() => new ParabolicSar(0, 0.2)).toThrow(RangeError);
    expect(() => new ParabolicSar(0.3, 0.2)).toThrow(RangeError);
  });
});

describe('Aroon', () => {
  it('is 100 / 0 when the high is the newest and the low the oldest (hand-checked)', () => {
    const rising = [1, 2, 3, 4].map((v) => span(v + 1, v));
    expect(computeSeries(new Aroon(3), rising)).toEqual([
      null,
      null,
      null,
      { up: 100, down: 0, oscillator: 100 },
    ]);
  });

  it('counts the candles since the extremes, and the more recent one wins a tie', () => {
    // highs 5, 9, 9, 4 (the 9 is 2 and 1 candles old -> the later counts), lows 3, 4, 5, 1 (newest)
    const bars = [span(5, 3), span(9, 4), span(9, 5), span(4, 1)];
    const last = computeSeries(new Aroon(3), bars).at(-1);
    // up: highest high 9 happened 1 candle ago -> 100 x (3 - 1) / 3; down: lowest low is now -> 100
    expect(round(last?.up ?? null, 6)).toBe(66.666667);
    expect(last?.down).toBe(100);
    expect(round(last?.oscillator ?? null, 6)).toBe(-33.333333);
  });

  it('needs period + 1 candles', () => {
    expect(new Aroon().warmup).toBe(26);
  });
});

describe('HeikinAshi', () => {
  it('smooths candles and counts the streak of one colour (hand-checked)', () => {
    const values = computeSeries(new HeikinAshi(), [
      bar(10, 12, 9, 11),
      bar(11, 13, 10, 12),
      bar(12, 14, 11, 13),
      bar(13, 13, 9, 10),
    ]);
    expect(values).toEqual([
      { o: 10.5, h: 12, l: 9, c: 10.5, streak: 0 },
      { o: 10.5, h: 13, l: 10, c: 11.5, streak: 1 },
      { o: 11, h: 14, l: 11, c: 12.5, streak: 2 },
      { o: 11.75, h: 13, l: 9, c: 11.25, streak: -1 },
    ]);
  });
});

describe('EfficiencyRatio', () => {
  it('is 1 on a straight line and 0 on a round trip (hand-checked)', () => {
    expect(computeSeries(new EfficiencyRatio(4), [1, 2, 3, 4, 5])).toEqual([
      null,
      null,
      null,
      null,
      1,
    ]);
    expect(computeSeries(new EfficiencyRatio(4), [1, 2, 1, 2, 1]).at(-1)).toBe(0);
  });

  it('is net move over path: 1 to 4 over 4 steps with one step back', () => {
    // closes 1,3,2,4,5: net 4, path 2+1+2+1 = 6
    expect(round(computeSeries(new EfficiencyRatio(4), [1, 3, 2, 4, 5]).at(-1) ?? null, 6)).toBe(
      0.666667,
    );
  });

  it('is 0 when nothing moves and defaults to a period of 20', () => {
    expect(computeSeries(new EfficiencyRatio(3), [5, 5, 5, 5]).at(-1)).toBe(0);
    expect(new EfficiencyRatio().period).toBe(20);
  });
});

describe('LinearRegression', () => {
  it('fits a straight line exactly (hand-checked)', () => {
    const last = computeSeries(new LinearRegression(4), [1, 3, 5, 7]).at(-1);
    expect(last).toMatchObject({ slope: 2, endpoint: 7 });
    expect(round(last?.intercept ?? null)).toBe(1);
    expect(round(last?.r2 ?? null)).toBe(1);
  });

  it('gives r2 = slope x Sxy / Syy for noisy data (hand-checked: 1, 2, 1, 2 -> slope 0.2, r2 0.2)', () => {
    const last = computeSeries(new LinearRegression(4), [1, 2, 1, 2]).at(-1);
    expect(round(last?.slope ?? null)).toBe(0.2);
    expect(round(last?.r2 ?? null)).toBe(0.2);
    expect(round(last?.endpoint ?? null)).toBe(1.8);
  });

  it('has r2 of 0 for a flat series, and is stable for prices near 4000', () => {
    expect(computeSeries(new LinearRegression(5), [7, 7, 7, 7, 7]).at(-1)).toMatchObject({
      slope: 0,
      r2: 0,
    });
    const prices = Array.from({ length: 20 }, (_, i) => 4017.285 + i * 0.1);
    const last = computeSeries(new LinearRegression(20), prices).at(-1);
    expect(last?.slope).toBeCloseTo(0.1, 9);
    expect(last?.r2).toBeCloseTo(1, 9);
  });

  it('has an r2 between 0 and 1 on random candles', () => {
    for (const value of computeSeries(
      new LinearRegression(30),
      randomBars(9, 300).map((b) => b.c),
    )) {
      if (value) {
        expect(value.r2).toBeGreaterThanOrEqual(0);
        expect(value.r2).toBeLessThanOrEqual(1);
      }
    }
  });

  it('needs at least two points and has no value from one', () => {
    expect(() => new LinearRegression(1)).toThrow(RangeError);
    expect(new LinearRegression(2).update(1)).toBeNull();
    expect(new LinearRegression(2).update(2)).toBeNull();
  });
});
