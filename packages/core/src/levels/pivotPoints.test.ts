import { describe, expect, it } from 'vitest';

import { camarillaPivots, classicPivots } from './pivotPoints';
import { roundLevelsAround, roundNumbersBetween } from './roundNumbers';

describe('classicPivots', () => {
  it('follows the textbook formulas (hand-checked: high 110, low 90, close 100)', () => {
    // P = 100, R1 = 2 x 100 - 90 = 110, S1 = 2 x 100 - 110 = 90, R2 = 120, S2 = 80,
    // R3 = 110 + 2 x (100 - 90) = 130, S3 = 90 - 2 x (110 - 100) = 70
    expect(classicPivots(110, 90, 100)).toEqual({
      pivot: 100,
      r1: 110,
      r2: 120,
      r3: 130,
      s1: 90,
      s2: 80,
      s3: 70,
    });
  });

  it('works with a close away from the middle (high 4030, low 4000, close 4024)', () => {
    const p = classicPivots(4030, 4000, 4024);
    expect(p.pivot).toBeCloseTo(4018, 9);
    expect(p.r1).toBeCloseTo(4036, 9);
    expect(p.s1).toBeCloseTo(4006, 9);
    expect(p.r2).toBeCloseTo(4048, 9);
    expect(p.s2).toBeCloseTo(3988, 9);
    expect(p.r3).toBeCloseTo(4066, 9);
    expect(p.s3).toBeCloseTo(3976, 9);
  });

  it('puts the levels in order: S3 < S2 < S1 < P < R1 < R2 < R3', () => {
    const p = classicPivots(4030.4, 3998.2, 4012.9);
    expect([p.s3, p.s2, p.s1, p.pivot, p.r1, p.r2, p.r3]).toEqual(
      [p.s3, p.s2, p.s1, p.pivot, p.r1, p.r2, p.r3].sort((a, b) => a - b),
    );
  });

  it('collapses to one price when nothing moved', () => {
    const p = classicPivots(100, 100, 100);
    expect(Object.values(p).every((v) => v === 100)).toBe(true);
  });
});

describe('camarillaPivots', () => {
  it('puts R1 to R4 and S1 to S4 at the close plus and minus 1.1 x range / 12, 6, 4 and 2 (hand-checked)', () => {
    // range 20: 1.1 x 20 = 22 -> 22/12, 22/6, 22/4, 22/2
    const p = camarillaPivots(110, 90, 100);
    expect(p.r1).toBeCloseTo(101.8333333, 6);
    expect(p.r2).toBeCloseTo(103.6666667, 6);
    expect(p.r3).toBeCloseTo(105.5, 9);
    expect(p.r4).toBeCloseTo(111, 9);
    expect(p.s1).toBeCloseTo(98.1666667, 6);
    expect(p.s2).toBeCloseTo(96.3333333, 6);
    expect(p.s3).toBeCloseTo(94.5, 9);
    expect(p.s4).toBeCloseTo(89, 9);
    expect(p.pivot).toBeCloseTo(100, 9);
  });

  it('is symmetrical around the close', () => {
    const p = camarillaPivots(4030.4, 3998.2, 4012.9);
    expect(p.r1 - 4012.9).toBeCloseTo(4012.9 - p.s1, 9);
    expect(p.r4 - 4012.9).toBeCloseTo(4012.9 - p.s4, 9);
  });
});

describe('pivot points: input', () => {
  it('refuses numbers that are not a real day', () => {
    for (const pivots of [classicPivots, camarillaPivots]) {
      expect(() => pivots(90, 110, 100)).toThrow(RangeError);
      expect(() => pivots(110, 90, 120)).toThrow(RangeError);
      expect(() => pivots(110, 90, 80)).toThrow(RangeError);
      expect(() => pivots(Number.NaN, 90, 100)).toThrow(RangeError);
    }
  });
});

describe('roundNumbersBetween', () => {
  it('lists every multiple of 10 with its rank: 100, 50 or 10 (hand-checked)', () => {
    expect(roundNumbersBetween(4012.3, 4067.8)).toEqual([
      { price: 4020, step: 10 },
      { price: 4030, step: 10 },
      { price: 4040, step: 10 },
      { price: 4050, step: 50 },
      { price: 4060, step: 10 },
    ]);
    expect(roundNumbersBetween(3995, 4105).map((l) => [l.price, l.step])).toEqual([
      [4000, 100],
      [4010, 10],
      [4020, 10],
      [4030, 10],
      [4040, 10],
      [4050, 50],
      [4060, 10],
      [4070, 10],
      [4080, 10],
      [4090, 10],
      [4100, 100],
    ]);
  });

  it('includes both ends when they are round, and is empty when none fits', () => {
    expect(roundNumbersBetween(4000, 4010).map((l) => l.price)).toEqual([4000, 4010]);
    expect(roundNumbersBetween(4001, 4009)).toEqual([]);
  });

  it('takes other steps', () => {
    expect(roundNumbersBetween(4000, 4030, [5, 25])).toEqual([
      { price: 4000, step: 25 },
      { price: 4005, step: 5 },
      { price: 4010, step: 5 },
      { price: 4015, step: 5 },
      { price: 4020, step: 5 },
      { price: 4025, step: 25 },
      { price: 4030, step: 5 },
    ]);
  });

  it('refuses a bad range, bad steps, or a range with far too many levels', () => {
    expect(() => roundNumbersBetween(10, 5)).toThrow(RangeError);
    expect(() => roundNumbersBetween(Number.NaN, 5)).toThrow(RangeError);
    expect(() => roundNumbersBetween(0, 100, [0])).toThrow(RangeError);
    expect(() => roundNumbersBetween(0, 100, [])).toThrow(RangeError);
    expect(() => roundNumbersBetween(0, 1_000_000)).toThrow(RangeError);
  });
});

describe('roundLevelsAround', () => {
  it('gives the multiples just below and above for every step, once each (hand-checked)', () => {
    // 10: 4010 and 4020. 50: 4000 and 4050. 100: 4000 and 4100.
    expect(roundLevelsAround(4017.285)).toEqual([
      { price: 4000, step: 100 },
      { price: 4010, step: 10 },
      { price: 4020, step: 10 },
      { price: 4050, step: 50 },
      { price: 4100, step: 100 },
    ]);
  });

  it('has one level when the price is exactly on a multiple of every step, and shares levels otherwise', () => {
    expect(roundLevelsAround(4000, [10, 50, 100])).toEqual([{ price: 4000, step: 100 }]);
    expect(roundLevelsAround(4050).map((l) => l.price)).toEqual([4000, 4050, 4100]);
  });

  it('keeps three decimals exact', () => {
    expect(roundLevelsAround(4009.999, [10])).toEqual([
      { price: 4000, step: 10 },
      { price: 4010, step: 10 },
    ]);
    expect(roundLevelsAround(4010.001, [10])).toEqual([
      { price: 4010, step: 10 },
      { price: 4020, step: 10 },
    ]);
  });

  it('refuses a price that is not a number', () => {
    expect(() => roundLevelsAround(Number.NaN)).toThrow(RangeError);
    expect(() => roundLevelsAround(1, [-5])).toThrow(RangeError);
  });
});
