import { describe, expect, it } from 'vitest';

import { Ema, Hull, Sma, Wma } from './averages';
import { roundAll } from './test-data';
import { computeSeries } from './types';

describe('Sma', () => {
  it('is the plain mean of the last 3 values (hand-checked)', () => {
    expect(computeSeries(new Sma(3), [1, 2, 3, 4, 5, 6])).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('with period 1 is the input', () => {
    expect(computeSeries(new Sma(1), [4, 7, 1])).toEqual([4, 7, 1]);
  });

  it('reports its warm-up, count and latest value', () => {
    const sma = new Sma(3);
    expect(sma.warmup).toBe(3);
    expect(sma.value).toBeNull();
    sma.update(1);
    sma.update(2);
    expect(sma.value).toBeNull();
    sma.update(6);
    expect(sma.value).toBe(3);
    expect(sma.count).toBe(3);
  });
});

describe('Ema', () => {
  it('seeds with the simple average and then follows alpha = 2/(period+1) (hand-checked)', () => {
    // period 3: alpha 0.5. seed = (2+4+6)/3 = 4; then 8*.5+4*.5 = 6; 10*.5+6*.5 = 8
    expect(computeSeries(new Ema(3), [2, 4, 6, 8, 10])).toEqual([null, null, 4, 6, 8]);
    // period 4: alpha 0.4. seed = 25; then 50*.4+25*.6 = 35
    expect(roundAll(computeSeries(new Ema(4), [10, 20, 30, 40, 50]))).toEqual([
      null,
      null,
      null,
      25,
      35,
    ]);
  });

  it('stays at a constant', () => {
    const values = computeSeries(
      new Ema(10),
      Array.from({ length: 40 }, () => 4017.285),
    );
    expect(values.slice(9).every((v) => v !== null && Math.abs(v - 4017.285) < 1e-9)).toBe(true);
  });

  it('forgets the seed: two different starts converge to the same value', () => {
    const tail = Array.from({ length: 200 }, (_, i) => 4000 + Math.sin(i / 7) * 5);
    const a = computeSeries(new Ema(10), [
      4100,
      4100,
      4100,
      4100,
      4100,
      4100,
      4100,
      4100,
      4100,
      4100,
      ...tail,
    ]).at(-1);
    const b = computeSeries(new Ema(10), [
      3900,
      3900,
      3900,
      3900,
      3900,
      3900,
      3900,
      3900,
      3900,
      3900,
      ...tail,
    ]).at(-1);
    expect(Math.abs((a ?? 0) - (b ?? 1))).toBeLessThan(1e-9);
  });
});

describe('Wma', () => {
  it('weights the newest value most (hand-checked)', () => {
    // [1,2,3] -> (1*1 + 2*2 + 3*3) / 6 = 14/6, [2,3,4] -> 20/6, [3,4,5] -> 26/6
    expect(roundAll(computeSeries(new Wma(3), [1, 2, 3, 4, 5]))).toEqual([
      null,
      null,
      2.333333333,
      3.333333333,
      4.333333333,
    ]);
  });

  it('equals the average for a constant series', () => {
    expect(computeSeries(new Wma(5), [7, 7, 7, 7, 7, 7]).at(-1)).toBeCloseTo(7, 12);
  });
});

describe('Hull', () => {
  it('has no lag on a straight line (hand-derived: WMA(2) = i+2/3, WMA(4) = i, so the result is i+1)', () => {
    const line = Array.from({ length: 8 }, (_, i) => i + 1);
    const hull = new Hull(4);
    expect(hull.warmup).toBe(5);
    expect(roundAll(computeSeries(hull, line))).toEqual([null, null, null, null, 5, 6, 7, 8]);
  });

  it('is smoother than its input and needs period >= 2', () => {
    expect(() => new Hull(1)).toThrow(RangeError);
    const noisy = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + (i % 2 === 0 ? 1 : -1));
    const values = computeSeries(new Hull(9), noisy).filter((v): v is number => v !== null);
    const jitter = (series: number[]) =>
      series.slice(1).reduce((sum, v, i) => sum + Math.abs(v - (series[i] ?? v)), 0);
    expect(jitter(values)).toBeLessThan(jitter(noisy.slice(-values.length)));
  });
});

describe('input checks', () => {
  it('rejects bad periods and non-finite inputs', () => {
    for (const make of [() => new Sma(0), () => new Ema(1.5), () => new Wma(-2)]) {
      expect(make).toThrow(RangeError);
    }
    expect(() => new Sma(3).update(Number.NaN)).toThrow(RangeError);
    expect(() => new Ema(3).update(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => new Hull(4).update(Number.NaN)).toThrow(RangeError);
  });
});
