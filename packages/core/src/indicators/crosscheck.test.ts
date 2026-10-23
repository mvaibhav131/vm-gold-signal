import {
  ADX,
  AO,
  ATR,
  BollingerBands,
  CCI,
  EMA,
  MACD,
  PSAR,
  ROC,
  RSI,
  SMA,
  StochasticRSI,
  TR,
  WMA,
  WilliamsR,
} from 'trading-signals';
import { describe, expect, it } from 'vitest';

import { Ema, Sma, Wma } from './averages';
import { Adx } from './directional';
import {
  AwesomeOscillator,
  Cci,
  Macd,
  Roc,
  Rsi,
  StochRsi,
  WilliamsR as OurWilliamsR,
} from './momentum';
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

/** A property of the library's indicator that may be a plain number or a getter-like function. */
function property(indicator: unknown, name: string): unknown {
  try {
    const value = (indicator as Record<string, unknown>)[name];
    return typeof value === 'function' ? (value as () => unknown).call(indicator) : value;
  } catch {
    return null;
  }
}

describe('against trading-signals (B5 momentum and directional indicators)', () => {
  it('RSI(14) agrees once the seed has been forgotten', () => {
    expectClose(
      computeSeries(new Rsi(14), closes),
      oracleSeries(() => new RSI(14), closes),
      300,
      1e-6,
    );
  });

  it('MACD(12, 26, 9) line, signal and histogram agree once the seeds have been forgotten', () => {
    const ours = computeSeries(new Macd(12, 26, 9), closes);
    const theirs = oracleSeries(() => new MACD(new EMA(12), new EMA(26), new EMA(9)), closes);
    for (const key of ['macd', 'signal', 'histogram'] as const) {
      expectClose(
        ours.map((v) => v?.[key] ?? null),
        theirs.map((v) => (v as Record<string, unknown> | null)?.[key] ?? null),
        300,
        1e-6,
      );
    }
  });

  it('ROC(10) agrees (the library gives a fraction, we give percent)', () => {
    const ours = computeSeries(new Roc(10), closes).map((v) => (v === null ? null : v / 100));
    expectClose(
      ours,
      oracleSeries(() => new ROC(10), closes),
      10,
      1e-9,
    );
  });

  it('CCI(20) agrees', () => {
    expectClose(
      computeSeries(new Cci(20), BARS),
      oracleSeries(() => new CCI(20), BARS.map(candle)),
      19,
      1e-6,
    );
  });

  it('Awesome oscillator(5, 34) agrees', () => {
    expectClose(
      computeSeries(new AwesomeOscillator(5, 34), BARS),
      oracleSeries(() => new AO(5, 34), BARS.map(candle)),
      33,
      1e-9,
    );
  });

  it('Williams %R(14) agrees', () => {
    expectClose(
      computeSeries(new OurWilliamsR(14), BARS),
      oracleSeries(() => new WilliamsR(14), BARS.map(candle)),
      13,
      1e-9,
    );
  });

  it('ADX(14) with +DI and -DI agrees once the seeds have been forgotten', () => {
    const ours = computeSeries(new Adx(14), BARS);
    const indicator = new ADX(14);
    const adx: unknown[] = [];
    const plus: unknown[] = [];
    const minus: unknown[] = [];
    for (const input of BARS.map(candle)) {
      feed(indicator, input);
      adx.push(read(indicator));
      plus.push(property(indicator, 'pdi'));
      minus.push(property(indicator, 'mdi'));
    }
    // The library reports ADX in percent like us, but +DI and -DI as fractions.
    const fraction = (pick: (v: NonNullable<(typeof ours)[number]>) => number) =>
      ours.map((v) => (v === null ? null : pick(v) / 100));
    expectClose(
      ours.map((v) => v?.adx ?? null),
      adx,
      300,
      1e-6,
    );
    expectClose(
      fraction((v) => v.plusDI),
      plus,
      300,
      1e-8,
    );
    expectClose(
      fraction((v) => v.minusDI),
      minus,
      300,
      1e-8,
    );
  });

  it('stochastic RSI (raw) agrees once the RSI seed has been forgotten (the library gives a fraction)', () => {
    const ours = computeSeries(new StochRsi(14, 14, 1, 1), closes).map((v) =>
      v === null ? null : v.raw / 100,
    );
    expectClose(
      ours,
      oracleSeries(() => new StochasticRSI(14), closes),
      300,
      1e-6,
    );
  });
});
