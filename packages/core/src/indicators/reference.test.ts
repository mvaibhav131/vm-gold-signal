import { describe, expect, it } from 'vitest';

import { Hull } from './averages';
import { closes, randomBars } from './test-data';
import {
  Aroon,
  EfficiencyRatio,
  HeikinAshi,
  LinearRegression,
  Supertrend,
  type Direction,
} from './trend';
import { type Bar, computeSeries } from './types';
import { Choppiness, Donchian, Keltner, PercentileRank } from './volatility';

// Second independent check (besides trading-signals, which lacks these indicators): the same
// definitions written the naive way, whole arrays and slices, no streaming state. If the
// streaming classes and these agree on random candles, the window bookkeeping is right.

const BARS = randomBars(11, 800);
const CLOSES = closes(BARS);
const TOLERANCE = 1e-9;

function expectSame(ours: readonly (number | null)[], reference: readonly (number | null)[]) {
  expect(ours).toHaveLength(reference.length);
  let compared = 0;
  ours.forEach((value, i) => {
    const expected = reference[i] ?? null;
    if (expected === null) {
      expect(value, `index ${String(i)} has no value`).toBeNull();
    } else {
      expect(Math.abs((value ?? Number.NaN) - expected), `index ${String(i)}`).toBeLessThan(
        TOLERANCE,
      );
      compared += 1;
    }
  });
  expect(compared).toBeGreaterThan(300);
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

function naiveWma(values: readonly number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const slice = values.slice(i + 1 - period, i + 1);
    return sum(slice.map((v, k) => v * (k + 1))) / ((period * (period + 1)) / 2);
  });
}

function naiveTrueRange(bars: readonly Bar[]): number[] {
  return bars.map((b, i) => {
    const previous = bars[i - 1];
    if (!previous) return b.h - b.l;
    return Math.max(b.h - b.l, Math.abs(b.h - previous.c), Math.abs(b.l - previous.c));
  });
}

function naiveWilder(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  let current = sum(values.slice(0, period)) / period;
  out[period - 1] = current;
  for (let i = period; i < values.length; i += 1) {
    current = (current * (period - 1) + (values[i] ?? 0)) / period;
    out[i] = current;
  }
  return out;
}

function naiveEma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const alpha = 2 / (period + 1);
  let current = sum(values.slice(0, period)) / period;
  out[period - 1] = current;
  for (let i = period; i < values.length; i += 1) {
    current = alpha * (values[i] ?? 0) + (1 - alpha) * current;
    out[i] = current;
  }
  return out;
}

describe('against naive reference implementations', () => {
  it('Hull(16) = WMA(4) of 2 x WMA(8) - WMA(16)', () => {
    const half = naiveWma(CLOSES, 8);
    const full = naiveWma(CLOSES, 16);
    const raw = CLOSES.map((_, i) => {
      const a = half[i];
      const b = full[i];
      return a === null || a === undefined || b === null || b === undefined ? null : 2 * a - b;
    });
    const firstRaw = raw.findIndex((v) => v !== null);
    const smooth = naiveWma(
      raw.slice(firstRaw).map((v) => v ?? 0),
      4,
    );
    const reference = [...raw.slice(0, firstRaw).map(() => null), ...smooth];
    expectSame(computeSeries(new Hull(16), CLOSES), reference);
  });

  it('Donchian(20) channel and prior channel', () => {
    const ours = computeSeries(new Donchian(20), BARS);
    const upper = BARS.map((_, i) =>
      i < 19 ? null : Math.max(...BARS.slice(i - 19, i + 1).map((b) => b.h)),
    );
    const lower = BARS.map((_, i) =>
      i < 19 ? null : Math.min(...BARS.slice(i - 19, i + 1).map((b) => b.l)),
    );
    const priorUpper = BARS.map((_, i) =>
      i < 20 ? null : Math.max(...BARS.slice(i - 20, i).map((b) => b.h)),
    );
    const priorLower = BARS.map((_, i) =>
      i < 20 ? null : Math.min(...BARS.slice(i - 20, i).map((b) => b.l)),
    );
    expectSame(
      ours.map((v) => v?.upper ?? null),
      upper,
    );
    expectSame(
      ours.map((v) => v?.lower ?? null),
      lower,
    );
    expectSame(
      ours.map((v) => v?.priorUpper ?? null),
      priorUpper,
    );
    expectSame(
      ours.map((v) => v?.priorLower ?? null),
      priorLower,
    );
  });

  it('Aroon(25) from the position of the extreme in the last 26 candles', () => {
    const ours = computeSeries(new Aroon(25), BARS);
    const reference = (pick: 'h' | 'l') =>
      BARS.map((_, i) => {
        if (i < 25) return null;
        const values = BARS.slice(i - 25, i + 1).map((b) => b[pick]);
        const extreme = pick === 'h' ? Math.max(...values) : Math.min(...values);
        const sinceExtreme = 25 - values.lastIndexOf(extreme);
        return (100 * (25 - sinceExtreme)) / 25;
      });
    expectSame(
      ours.map((v) => v?.up ?? null),
      reference('h'),
    );
    expectSame(
      ours.map((v) => v?.down ?? null),
      reference('l'),
    );
  });

  it('Choppiness(14) from the definition', () => {
    const tr = naiveTrueRange(BARS);
    const reference = BARS.map((_, i) => {
      if (i < 13) return null;
      const window = BARS.slice(i - 13, i + 1);
      const range = Math.max(...window.map((b) => b.h)) - Math.min(...window.map((b) => b.l));
      return (100 * Math.log10(sum(tr.slice(i - 13, i + 1)) / range)) / Math.log10(14);
    });
    expectSame(computeSeries(new Choppiness(14), BARS), reference);
  });

  it('EfficiencyRatio(20)', () => {
    const reference = CLOSES.map((_, i) => {
      if (i < 20) return null;
      const window = CLOSES.slice(i - 20, i + 1);
      const path = sum(window.slice(1).map((v, k) => Math.abs(v - (window[k] ?? v))));
      return Math.abs((window.at(-1) ?? 0) - (window[0] ?? 0)) / path;
    });
    expectSame(computeSeries(new EfficiencyRatio(20), CLOSES), reference);
  });

  it('LinearRegression(30) from the normal equations', () => {
    const ours = computeSeries(new LinearRegression(30), CLOSES);
    const slope: (number | null)[] = [];
    const endpoint: (number | null)[] = [];
    const r2: (number | null)[] = [];
    CLOSES.forEach((_, i) => {
      if (i < 29) {
        slope.push(null);
        endpoint.push(null);
        r2.push(null);
        return;
      }
      const y = CLOSES.slice(i - 29, i + 1);
      const x = y.map((_, k) => k);
      const n = 30;
      const sx = sum(x);
      const sy = sum(y);
      const sxy = sum(x.map((v, k) => v * (y[k] ?? 0)));
      const sxx = sum(x.map((v) => v * v));
      const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const a = (sy - b * sx) / n;
      const mean = sy / n;
      const residual = sum(y.map((v, k) => (v - (a + b * (x[k] ?? 0))) ** 2));
      const total = sum(y.map((v) => (v - mean) ** 2));
      slope.push(b);
      endpoint.push(a + b * 29);
      r2.push(1 - residual / total);
    });
    expectSame(
      ours.map((v) => v?.slope ?? null),
      slope,
    );
    expectSame(
      ours.map((v) => v?.endpoint ?? null),
      endpoint,
    );
    expectSame(
      ours.map((v) => v?.r2 ?? null),
      r2,
    );
  });

  it('PercentileRank(50)', () => {
    const reference = CLOSES.map((value, i) => {
      if (i < 50) return null;
      const previous = CLOSES.slice(i - 50, i);
      return (100 * previous.filter((v) => v <= value).length) / 50;
    });
    expectSame(computeSeries(new PercentileRank(50), CLOSES), reference);
  });

  it('Keltner(20, 1.5, ATR 14) from a naive EMA and a naive Wilder ATR', () => {
    const middle = naiveEma(CLOSES, 20);
    const atr = naiveWilder(naiveTrueRange(BARS), 14);
    const ours = computeSeries(new Keltner(20, 1.5, 14), BARS);
    const upper = middle.map((m, i) =>
      m === null || atr[i] === null ? null : m + 1.5 * (atr[i] ?? 0),
    );
    const lower = middle.map((m, i) =>
      m === null || atr[i] === null ? null : m - 1.5 * (atr[i] ?? 0),
    );
    expectSame(
      ours.map((v) => v?.upper ?? null),
      upper,
    );
    expectSame(
      ours.map((v) => v?.lower ?? null),
      lower,
    );
    expectSame(
      ours.map((v) => v?.middle ?? null),
      middle.map((m, i) => (atr[i] === null ? null : m)),
    );
  });

  it('HeikinAshi candles and streak', () => {
    const ours = computeSeries(new HeikinAshi(), BARS);
    const haClose = BARS.map((b) => (b.o + b.h + b.l + b.c) / 4);
    const haOpen: number[] = [];
    BARS.forEach((b, i) => {
      haOpen.push(i === 0 ? (b.o + b.c) / 2 : ((haOpen[i - 1] ?? 0) + (haClose[i - 1] ?? 0)) / 2);
    });
    expectSame(
      ours.map((v) => v?.c ?? null),
      haClose,
    );
    expectSame(
      ours.map((v) => v?.o ?? null),
      haOpen,
    );
    expectSame(
      ours.map((v) => v?.h ?? null),
      BARS.map((b, i) => Math.max(b.h, haOpen[i] ?? 0, haClose[i] ?? 0)),
    );
    // The streak is the run length of the sign of (close - open).
    let run = 0;
    const streaks = BARS.map((_, i) => {
      const colour = Math.sign((haClose[i] ?? 0) - (haOpen[i] ?? 0));
      run = colour === 0 ? 0 : Math.sign(run) === colour ? run + colour : colour;
      return run;
    });
    expect(ours.map((v) => v?.streak)).toEqual(streaks);
  });

  it('Supertrend(10, 3) written as whole arrays', () => {
    const period = 10;
    const multiplier = 3;
    const atr = naiveWilder(naiveTrueRange(BARS), period);
    const values: (number | null)[] = BARS.map(() => null);
    const directions: (Direction | null)[] = BARS.map(() => null);
    let upper = 0;
    let lower = 0;
    let direction: Direction = 'UP';
    for (let i = period - 1; i < BARS.length; i += 1) {
      const b = BARS[i];
      const a = atr[i];
      if (!b || a === null || a === undefined) continue;
      const mid = (b.h + b.l) / 2;
      const basicUpper = mid + multiplier * a;
      const basicLower = mid - multiplier * a;
      if (i === period - 1) {
        upper = basicUpper;
        lower = basicLower;
        direction = b.c >= mid ? 'UP' : 'DOWN';
      } else {
        const previousClose = BARS[i - 1]?.c ?? 0;
        const nextUpper = basicUpper < upper || previousClose > upper ? basicUpper : upper;
        const nextLower = basicLower > lower || previousClose < lower ? basicLower : lower;
        upper = nextUpper;
        lower = nextLower;
        if (direction === 'DOWN' && b.c > upper) direction = 'UP';
        else if (direction === 'UP' && b.c < lower) direction = 'DOWN';
      }
      values[i] = direction === 'UP' ? lower : upper;
      directions[i] = direction;
    }
    const ours = computeSeries(new Supertrend(period, multiplier), BARS);
    expectSame(
      ours.map((v) => v?.value ?? null),
      values,
    );
    expect(ours.map((v) => v?.direction ?? null)).toEqual(directions);
    expect(new Set(directions).size).toBe(3); // null, UP and DOWN all occur: it really flips
  });
});
