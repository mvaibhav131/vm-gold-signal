import { ATR, BollingerBands, EMA, PSAR, SMA, TR, WMA } from 'trading-signals';
import { describe, expect, it } from 'vitest';

import { Ema, Sma, Wma } from './averages';
import { randomBars } from './test-data';
import { ParabolicSar } from './trend';
import { type Bar, computeSeries } from './types';
import { Atr, Bollinger, TrueRange } from './volatility';

// B4 exit criterion: an independent cross-check against `trading-signals` (a test dependency
// only, never used by the engine). It is a separate implementation of the same textbook formulas,
// so agreement means neither of us made the same mistake. Where the two start differently
// (the seed of a recursive average) the check starts after the values have converged.

/** The few methods of the library that the check needs; its exact version differences are hidden here. */
interface Oracle {
  add?: (value: unknown) => unknown;
  update?: (value: unknown, replace?: boolean) => unknown;
  getResult?: () => unknown;
}

function feed(indicator: unknown, value: unknown): void {
  const oracle = indicator as Oracle;
  if (typeof oracle.add === 'function') oracle.add(value);
  else oracle.update?.(value, false);
}

function read(indicator: unknown): unknown {
  try {
    return (indicator as Oracle).getResult?.() ?? null;
  } catch {
    return null;
  }
}

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const BARS = randomBars(7, 600);
const candle = (b: Bar) => ({ high: b.h, low: b.l, close: b.c, open: b.o });

/** The values of the library for every input, in the same shape as ours. */
function oracleSeries(make: () => unknown, inputs: readonly unknown[]): unknown[] {
  const indicator = make();
  return inputs.map((input) => {
    feed(indicator, input);
    return read(indicator);
  });
}

function expectClose(
  ours: readonly (number | null)[],
  theirs: readonly unknown[],
  from: number,
  tolerance: number,
  skip: ReadonlySet<number> = new Set(),
) {
  let compared = 0;
  for (let i = from; i < ours.length; i += 1) {
    if (skip.has(i)) continue;
    const a = ours[i] ?? Number.NaN;
    const b = toNumber(theirs[i]) ?? Number.NaN;
    expect(
      Math.abs(a - b),
      `index ${String(i)}: ours ${String(a)}, library ${String(b)}`,
    ).toBeLessThan(tolerance);
    compared += 1;
  }
  expect(compared).toBeGreaterThan(100);
}

const closes = BARS.map((b) => b.c);

describe('against trading-signals', () => {
  it('SMA(20) agrees exactly', () => {
    expectClose(
      computeSeries(new Sma(20), closes),
      oracleSeries(() => new SMA(20), closes),
      19,
      1e-9,
    );
  });

  it('WMA(20) agrees exactly', () => {
    expectClose(
      computeSeries(new Wma(20), closes),
      oracleSeries(() => new WMA(20), closes),
      19,
      1e-9,
    );
  });

  it('EMA(20) agrees once the seed has been forgotten', () => {
    // The influence of the first value shrinks by (1 - 2/21) per candle: 300 candles is far below 1e-9.
    expectClose(
      computeSeries(new Ema(20), closes),
      oracleSeries(() => new EMA(20), closes),
      300,
      1e-7,
    );
  });

  it('true range agrees exactly', () => {
    expectClose(
      computeSeries(new TrueRange(), BARS),
      oracleSeries(() => new TR(), BARS.map(candle)),
      1,
      1e-9,
    );
  });

  it('ATR(14) with Wilder smoothing agrees once the seed has been forgotten', () => {
    expectClose(
      computeSeries(new Atr(14), BARS),
      oracleSeries(() => new ATR(14), BARS.map(candle)),
      300,
      1e-7,
    );
  });

  it('Bollinger(20, 2) bands agree exactly (population standard deviation)', () => {
    const ours = computeSeries(new Bollinger(20, 2), closes);
    const theirs = oracleSeries(() => new BollingerBands(20, 2), closes);
    for (const key of ['upper', 'middle', 'lower'] as const) {
      expectClose(
        ours.map((v) => v?.[key] ?? null),
        theirs.map((v) => (v as Record<string, unknown> | null)?.[key] ?? null),
        19,
        1e-9,
      );
    }
  });

  it('is not vacuous: a different period is noticed', () => {
    expect(() => {
      expectClose(
        computeSeries(new Sma(19), closes),
        oracleSeries(() => new SMA(20), closes),
        19,
        1e-9,
      );
    }).toThrow();
  });

  it('Parabolic SAR: the stop at (nearly) every reversal is the old extreme in both', () => {
    // Convention difference, not an error: Wilder (and TA-Lib) never let the SAR enter the range of
    // the previous TWO candles; trading-signals looks at the previous candle only. So the two
    // differ by a few cents on candles where the older candle's extreme is the binding one. The
    // reversal itself is the same in both: the new SAR is the extreme point of the old trend.
    // The hand-checked vector in trend.test.ts pins down the two-candle rule.
    const ours = computeSeries(new ParabolicSar(0.02, 0.2), BARS);
    const theirs = oracleSeries(
      () => new PSAR({ accelerationStep: 0.02, accelerationMax: 0.2 }),
      BARS.map(candle),
    );
    const reversals = ours.flatMap((v, i) => (v?.reversed === true ? [i] : []));
    expect(reversals.length).toBeGreaterThan(20);
    const agree = reversals.filter(
      (i) => Math.abs((ours[i]?.sar ?? 0) - (toNumber(theirs[i]) ?? 1e9)) < 1e-9,
    );
    // One reversal in about twenty falls on a different candle in the two, because their stops
    // differed by a few cents just before it; all the others give the identical stop.
    expect(agree.length / reversals.length).toBeGreaterThan(0.9);
  });
});
