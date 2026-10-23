import { describe, expect, it } from 'vitest';

import { bar, round } from './test-data';
import { AnchoredMean, GarmanKlass, RealisedVolatility, type WeightedBar } from './statistical';
import { computeSeries } from './types';

const point = (price: number, weight: number): WeightedBar => ({
  h: price,
  l: price,
  c: price,
  weight,
});

describe('RealisedVolatility', () => {
  it('is the root of the mean squared log return (hand-checked)', () => {
    // 100 -> 110 -> 100: log returns +ln(1.1) and -ln(1.1)
    const values = computeSeries(new RealisedVolatility(2), [100, 110, 100]);
    expect(values.slice(0, 2)).toEqual([null, null]);
    expect(round(values[2] ?? null, 10)).toBe(0.0953101798);
  });

  it('is 0 for a flat series and needs period + 1 closes', () => {
    expect(computeSeries(new RealisedVolatility(3), [5, 5, 5, 5]).at(-1)).toBe(0);
    expect(new RealisedVolatility(3).warmup).toBe(4);
  });

  it('refuses a price that is not above zero', () => {
    expect(() => new RealisedVolatility(2).update(0)).toThrow(RangeError);
    expect(() => new RealisedVolatility(2).update(-1)).toThrow(RangeError);
  });
});

describe('GarmanKlass', () => {
  it('uses the high-low range and the open-close body (hand-checked)', () => {
    // 0.5 x ln(110/100)^2 - (2 ln 2 - 1) x ln(105/100)^2 = 0.0036226 -> root 0.0601863
    const value = computeSeries(new GarmanKlass(1), [bar(100, 110, 100, 105)])[0];
    expect(round(value ?? null, 6)).toBe(0.060187);
  });

  it('is 0 for a candle that did not move', () => {
    expect(computeSeries(new GarmanKlass(1), [bar(5, 5, 5, 5)])[0]).toBe(0);
  });

  it('is never below zero even when the body is bigger than the range allows', () => {
    // open and close outside the high-low range is not a real candle, the clamp keeps the root defined
    const value = computeSeries(new GarmanKlass(1), [bar(100, 100.01, 100, 130)])[0];
    expect(value).toBe(0);
  });

  it('averages the candle variances over the period', () => {
    const quiet = bar(100, 100, 100, 100);
    const moving = bar(100, 110, 100, 105);
    const [, second] = computeSeries(new GarmanKlass(2), [quiet, moving]);
    const alone = computeSeries(new GarmanKlass(1), [moving])[0] ?? 0;
    expect(second).toBeCloseTo(alone / Math.SQRT2, 12);
  });
});

describe('AnchoredMean', () => {
  it('is the weighted mean and deviation of the typical price (hand-checked)', () => {
    // 10 with weight 1 and 20 with weight 3: mean 17.5, variance (56.25 + 3 x 6.25) / 4 = 18.75
    const indicator = new AnchoredMean();
    indicator.update(point(10, 1));
    const value = indicator.update(point(20, 3));
    expect(value?.mean).toBeCloseTo(17.5, 12);
    expect(value?.deviation).toBeCloseTo(4.330127, 6);
    expect(value?.upper1).toBeCloseTo(17.5 + 4.330127, 6);
    expect(value?.lower2).toBeCloseTo(17.5 - 2 * 4.330127, 6);
    expect(value?.totalWeight).toBe(4);
  });

  it('uses (high + low + close) / 3', () => {
    const value = new AnchoredMean().update({ h: 12, l: 6, c: 9, weight: 1 });
    expect(value?.mean).toBe(9);
    expect(value?.deviation).toBe(0);
  });

  it('has no value until some weight exists, and weight 0 counts for nothing', () => {
    const indicator = new AnchoredMean();
    expect(indicator.update(point(10, 0))).toBeNull();
    expect(indicator.update(point(10, 2))?.mean).toBe(10);
    expect(indicator.update(point(99, 0))?.mean).toBe(10);
    expect(indicator.count).toBe(3);
  });

  it('forgets everything before a new anchor', () => {
    const indicator = new AnchoredMean();
    indicator.update(point(10, 5));
    indicator.update(point(30, 5));
    indicator.reset();
    expect(indicator.value).toBeNull();
    expect(indicator.update(point(50, 1))?.mean).toBe(50);
  });

  it('stays exact at gold prices with tiny differences', () => {
    const indicator = new AnchoredMean();
    let last = null;
    for (let i = 0; i < 5000; i += 1) last = indicator.update(point(4017.285 + (i % 2) * 0.001, 1));
    expect(last?.mean).toBeCloseTo(4017.2855, 8);
    expect(last?.deviation).toBeCloseTo(0.0005, 8);
  });

  it('refuses a negative weight or a value that is not a number', () => {
    expect(() => new AnchoredMean().update(point(10, -1))).toThrow(RangeError);
    expect(() => new AnchoredMean().update(point(Number.NaN, 1))).toThrow(RangeError);
  });
});
