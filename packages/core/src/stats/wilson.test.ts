import { describe, expect, it } from 'vitest';

import { Z_95, wilson, wilsonInterval } from './wilson';

describe('the Wilson score interval against published values', () => {
  // Newcombe (1998), "Two-sided confidence intervals for the single proportion", Table 1,
  // the Wilson score method without continuity correction, 95%.
  const published: [number, number, number, number][] = [
    [81, 263, 0.2553, 0.3662],
    [15, 148, 0.0624, 0.1605],
    [0, 20, 0, 0.1611],
    [1, 29, 0.0061, 0.1718],
  ];

  it.each(published)('%s of %s', (wins, n, low, high) => {
    const [l, h] = wilsonInterval(wins, n);
    expect(l).toBeCloseTo(low, 4);
    expect(h).toBeCloseTo(high, 4);
  });

  it('is the 1.96 interval, rounded to 3 decimals, as the dashboard shows it', () => {
    expect(Z_95).toBe(1.96);
    expect(wilson(118, 214)).toEqual([0.484, 0.617]);
    expect(wilson(35, 64)).toEqual([0.426, 0.663]);
    expect(wilson(20, 40)).toEqual([0.352, 0.648]);
    expect(wilson(0, 30)).toEqual([0, 0.114]);
    expect(wilson(30, 30)).toEqual([0.886, 1]);
  });
});

describe('what the interval is', () => {
  const samples: [number, number][] = [];
  for (const n of [1, 2, 5, 10, 30, 64, 100, 250, 1000]) {
    for (const share of [0, 0.1, 0.25, 0.5, 0.58, 0.9, 1]) samples.push([Math.round(share * n), n]);
  }

  it('solves the defining equation: (p - bound)^2 = z^2 x bound x (1 - bound) / n', () => {
    for (const [wins, n] of samples) {
      const p = wins / n;
      const [low, high] = wilsonInterval(wins, n);
      for (const bound of [low, high]) {
        // a bound that was cut at 0 or 1 is not a root of the equation
        if (bound <= 0 || bound >= 1) continue;
        const left = (p - bound) ** 2;
        const right = (Z_95 ** 2 * bound * (1 - bound)) / n;
        expect(left, `${String(wins)}/${String(n)} at ${String(bound)}`).toBeCloseTo(right, 12);
      }
    }
  });

  it('holds the share, is ordered and stays inside 0 to 1', () => {
    for (const [wins, n] of samples) {
      const p = wins / n;
      const [low, high] = wilsonInterval(wins, n);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
      expect(low).toBeLessThanOrEqual(p + 1e-12);
      expect(high).toBeGreaterThanOrEqual(p - 1e-12);
      expect(low).toBeLessThan(high);
    }
  });

  it('is cut at exactly 0 for no win and at exactly 1 for all wins', () => {
    for (const n of [1, 7, 30, 500]) {
      expect(wilsonInterval(0, n)[0]).toBe(0);
      expect(wilsonInterval(n, n)[1]).toBe(1);
      expect(wilsonInterval(0, n)[1]).toBeGreaterThan(0);
      expect(wilsonInterval(n, n)[0]).toBeLessThan(1);
    }
  });

  it('is symmetric: wins and losses are mirror images', () => {
    for (const [wins, n] of samples) {
      const [low, high] = wilsonInterval(wins, n);
      const [mirrorLow, mirrorHigh] = wilsonInterval(n - wins, n);
      expect(mirrorLow).toBeCloseTo(1 - high, 12);
      expect(mirrorHigh).toBeCloseTo(1 - low, 12);
    }
  });

  it('gets narrower with more trades at the same share, and moves up with more wins', () => {
    const width = (wins: number, n: number) => {
      const [low, high] = wilsonInterval(wins, n);
      return high - low;
    };
    expect(width(30, 60)).toBeLessThan(width(15, 30));
    expect(width(300, 600)).toBeLessThan(width(30, 60));
    for (let wins = 0; wins < 40; wins += 1) {
      const [low, high] = wilsonInterval(wins, 40);
      const [nextLow, nextHigh] = wilsonInterval(wins + 1, 40);
      expect(nextLow).toBeGreaterThan(low);
      expect(nextHigh).toBeGreaterThan(high);
    }
  });

  it('takes another confidence level with z', () => {
    const [low95, high95] = wilsonInterval(35, 64);
    const [low90, high90] = wilsonInterval(35, 64, 1.645);
    expect(low90).toBeGreaterThan(low95);
    expect(high90).toBeLessThan(high95);
  });
});

describe('the rounded interval', () => {
  it('is the interval rounded to 3 decimals, and a rate rounded the same way is inside it', () => {
    for (const [wins, n] of [
      [1, 30],
      [17, 30],
      [58, 100],
      [37, 64],
      [999, 1000],
    ] as const) {
      const [low, high] = wilsonInterval(wins, n);
      expect(wilson(wins, n)).toEqual([
        Math.round(low * 1000) / 1000,
        Math.round(high * 1000) / 1000,
      ]);
      const rate = Math.round((wins / n) * 1000) / 1000;
      const [roundedLow, roundedHigh] = wilson(wins, n);
      expect(rate).toBeGreaterThanOrEqual(roundedLow);
      expect(rate).toBeLessThanOrEqual(roundedHigh);
    }
  });
});

describe('what is refused', () => {
  it('needs a whole n above zero and whole wins from 0 to n', () => {
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(1, -5)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 2.5)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(2.5, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(Number.NaN, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1, Number.NaN)).toThrow(RangeError);
    expect(() => wilson(0, 0)).toThrow(RangeError);
  });

  it('needs a z above zero', () => {
    expect(() => wilsonInterval(5, 10, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(5, 10, -1.96)).toThrow(RangeError);
    expect(() => wilsonInterval(5, 10, Number.NaN)).toThrow(RangeError);
    expect(() => wilsonInterval(5, 10, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('accepts the smallest sample', () => {
    expect(() => wilsonInterval(0, 1)).not.toThrow();
    expect(() => wilsonInterval(1, 1)).not.toThrow();
  });
});
