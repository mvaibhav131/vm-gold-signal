import { describe, expect, it } from 'vitest';

import { Adx, Ichimoku } from './directional';
import { AwesomeOscillator, Cci, Macd, Roc, Rsi, StochRsi, WilliamsR } from './momentum';
import { AnchoredMean, GarmanKlass, RealisedVolatility } from './statistical';
import { closes, randomBars } from './test-data';
import { computeSeries } from './types';
import { mulberry32 } from '../candles/test-fixtures';

// The B5 indicators written the naive way (whole arrays, slices, no streaming state) and compared
// with the streaming classes on random candles. Same idea as reference.test.ts.

const BARS = randomBars(23, 900);
const CLOSES = closes(BARS);
const TOLERANCE = 1e-9;

type Series = readonly (number | null)[];

function expectSame(ours: Series, reference: Series, atLeast = 300) {
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
  expect(compared).toBeGreaterThan(atLeast);
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: readonly number[]) => sum(values) / values.length;
const at = (values: readonly number[], index: number) => values[index] ?? 0;

function naiveSma(values: readonly (number | null)[], period: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i + 1 - period), i + 1);
    if (slice.length < period || slice.some((v) => v === null)) return null;
    return mean(slice as number[]);
  });
}

function naiveEma(values: readonly (number | null)[], period: number): (number | null)[] {
  const first = values.findIndex((v) => v !== null);
  const out: (number | null)[] = values.map(() => null);
  const alpha = 2 / (period + 1);
  let current = mean(values.slice(first, first + period) as number[]);
  out[first + period - 1] = current;
  for (let i = first + period; i < values.length; i += 1) {
    current = alpha * (values[i] ?? 0) + (1 - alpha) * current;
    out[i] = current;
  }
  return out;
}

function rsiFrom(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function naiveRsi(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const up = values.map((v, i) => (i === 0 ? 0 : Math.max(v - at(values, i - 1), 0)));
  const down = values.map((v, i) => (i === 0 ? 0 : Math.max(at(values, i - 1) - v, 0)));
  let gain = sum(up.slice(1, period + 1)) / period;
  let loss = sum(down.slice(1, period + 1)) / period;
  out[period] = rsiFrom(gain, loss);
  for (let i = period + 1; i < values.length; i += 1) {
    gain = (gain * (period - 1) + at(up, i)) / period;
    loss = (loss * (period - 1) + at(down, i)) / period;
    out[i] = rsiFrom(gain, loss);
  }
  return out;
}

describe('against naive reference implementations (momentum)', () => {
  it('RSI(14)', () => {
    expectSame(computeSeries(new Rsi(14), CLOSES), naiveRsi(CLOSES, 14));
  });

  it('RSI(5) stays between 0 and 100', () => {
    const ours = computeSeries(new Rsi(5), CLOSES);
    expect(ours.every((v) => v === null || (v >= 0 && v <= 100))).toBe(true);
    expectSame(ours, naiveRsi(CLOSES, 5));
  });

  it('StochRSI(14, 14, 3, 3) from a naive RSI, window and averages', () => {
    const rsi = naiveRsi(CLOSES, 14);
    const raw = rsi.map((value, i) => {
      const window = rsi.slice(i - 13, i + 1);
      if (value === null || i < 13 || window.some((v) => v === null)) return null;
      const numbers = window as number[];
      const high = Math.max(...numbers);
      const low = Math.min(...numbers);
      return high === low ? 50 : (100 * (value - low)) / (high - low);
    });
    const k = naiveSma(raw, 3);
    const d = naiveSma(k, 3);
    const ours = computeSeries(new StochRsi(), CLOSES);
    expectSame(
      ours.map((v) => v?.raw ?? null),
      // the raw value only exists in ours once %K and %D do
      raw.map((v, i) => (d[i] === null ? null : v)),
    );
    expectSame(
      ours.map((v) => v?.k ?? null),
      k.map((v, i) => (d[i] === null ? null : v)),
    );
    expectSame(
      ours.map((v) => v?.d ?? null),
      d,
    );
  });

  it('MACD(12, 26, 9) from naive EMAs', () => {
    const fast = naiveEma(CLOSES, 12);
    const slow = naiveEma(CLOSES, 26);
    const line = CLOSES.map((_, i) => {
      const a = fast[i];
      const b = slow[i];
      return a === null || a === undefined || b === null || b === undefined ? null : a - b;
    });
    const signal = naiveEma(line, 9);
    const histogram = line.map((v, i) =>
      v === null || signal[i] === null ? null : v - (signal[i] ?? 0),
    );
    const ours = computeSeries(new Macd(), CLOSES);
    expectSame(
      ours.map((v) => v?.macd ?? null),
      line.map((v, i) => (signal[i] === null ? null : v)),
    );
    expectSame(
      ours.map((v) => v?.signal ?? null),
      signal,
    );
    expectSame(
      ours.map((v) => v?.histogram ?? null),
      histogram,
    );
    expectSame(
      ours.map((v) => v?.histogramChange ?? null),
      histogram.map((v, i) => {
        const before = histogram[i - 1];
        return v === null || before === null || before === undefined ? null : v - before;
      }),
    );
  });

  it('ROC(10)', () => {
    const reference = CLOSES.map((value, i) =>
      i < 10 ? null : (100 * (value - at(CLOSES, i - 10))) / at(CLOSES, i - 10),
    );
    expectSame(computeSeries(new Roc(10), CLOSES), reference);
  });

  it('CCI(20)', () => {
    const typical = BARS.map((b) => (b.h + b.l + b.c) / 3);
    const reference = typical.map((value, i) => {
      if (i < 19) return null;
      const window = typical.slice(i - 19, i + 1);
      const average = mean(window);
      const deviation = mean(window.map((v) => Math.abs(v - average)));
      return (value - average) / (0.015 * deviation);
    });
    expectSame(computeSeries(new Cci(20), BARS), reference);
  });

  it('Williams %R(14)', () => {
    const reference = BARS.map((b, i) => {
      if (i < 13) return null;
      const window = BARS.slice(i - 13, i + 1);
      const high = Math.max(...window.map((x) => x.h));
      const low = Math.min(...window.map((x) => x.l));
      return (-100 * (high - b.c)) / (high - low);
    });
    expectSame(computeSeries(new WilliamsR(14), BARS), reference);
  });

  it('Awesome oscillator(5, 34)', () => {
    const median = BARS.map((b) => (b.h + b.l) / 2);
    const fast = naiveSma(median, 5);
    const slow = naiveSma(median, 34);
    const reference = median.map((_, i) =>
      slow[i] === null ? null : (fast[i] ?? 0) - (slow[i] ?? 0),
    );
    expectSame(computeSeries(new AwesomeOscillator(), BARS), reference);
  });
});

describe('against naive reference implementations (directional, volatility, anchored mean)', () => {
  it('ADX(14) with +DI and -DI from whole arrays', () => {
    const period = 14;
    const tr: number[] = [];
    const plus: number[] = [];
    const minus: number[] = [];
    BARS.forEach((b, i) => {
      const before = BARS[i - 1];
      if (!before) {
        tr.push(0);
        plus.push(0);
        minus.push(0);
        return;
      }
      const up = b.h - before.h;
      const down = before.l - b.l;
      plus.push(up > down && up > 0 ? up : 0);
      minus.push(down > up && down > 0 ? down : 0);
      tr.push(Math.max(b.h - b.l, Math.abs(b.h - before.c), Math.abs(b.l - before.c)));
    });
    const smooth = (values: readonly number[]) => {
      const out: (number | null)[] = values.map(() => null);
      let current = sum(values.slice(1, period + 1));
      out[period] = current;
      for (let i = period + 1; i < values.length; i += 1) {
        current = current - current / period + at(values, i);
        out[i] = current;
      }
      return out;
    };
    const trS = smooth(tr);
    const plusS = smooth(plus);
    const minusS = smooth(minus);
    const plusDI = trS.map((t, i) => (t === null ? null : (100 * (plusS[i] ?? 0)) / t));
    const minusDI = trS.map((t, i) => (t === null ? null : (100 * (minusS[i] ?? 0)) / t));
    const dx = plusDI.map((p, i) => {
      const m = minusDI[i];
      return p === null || m === null || m === undefined ? null : (100 * Math.abs(p - m)) / (p + m);
    });
    const adx: (number | null)[] = dx.map(() => null);
    const firstDx = dx.findIndex((v) => v !== null);
    let current = mean(dx.slice(firstDx, firstDx + period) as number[]);
    adx[firstDx + period - 1] = current;
    for (let i = firstDx + period; i < dx.length; i += 1) {
      current = (current * (period - 1) + (dx[i] ?? 0)) / period;
      adx[i] = current;
    }
    const ours = computeSeries(new Adx(period), BARS);
    const shown = (series: Series) => series.map((v, i) => (adx[i] === null ? null : v));
    expectSame(
      ours.map((v) => v?.adx ?? null),
      adx,
    );
    expectSame(
      ours.map((v) => v?.plusDI ?? null),
      shown(plusDI),
    );
    expectSame(
      ours.map((v) => v?.minusDI ?? null),
      shown(minusDI),
    );
    expectSame(
      ours.map((v) => v?.dx ?? null),
      shown(dx),
    );
  });

  it('Ichimoku(9, 26, 52, 26) with the cloud read from earlier candles', () => {
    const [tenkanPeriod, kijunPeriod, spanBPeriod, displacement] = [9, 26, 52, 26] as const;
    const middle = (i: number, period: number): number | null => {
      if (i + 1 < period) return null;
      const window = BARS.slice(i + 1 - period, i + 1);
      return (Math.max(...window.map((b) => b.h)) + Math.min(...window.map((b) => b.l))) / 2;
    };
    const ours = computeSeries(new Ichimoku(), BARS);
    const reference = {
      tenkan: [] as (number | null)[],
      kijun: [] as (number | null)[],
      spanA: [] as (number | null)[],
      spanB: [] as (number | null)[],
      futureSpanA: [] as (number | null)[],
      futureSpanB: [] as (number | null)[],
      cloudTop: [] as (number | null)[],
      cloudBottom: [] as (number | null)[],
      chikouDelta: [] as (number | null)[],
    };
    const positions: (string | null)[] = [];
    BARS.forEach((bar, i) => {
      const tenkan = middle(i, tenkanPeriod);
      const kijun = middle(i, kijunPeriod);
      const earlier = i - displacement;
      const earlierTenkan = earlier < 0 ? null : middle(earlier, tenkanPeriod);
      const earlierKijun = earlier < 0 ? null : middle(earlier, kijunPeriod);
      const spanB = earlier < 0 ? null : middle(earlier, spanBPeriod);
      const spanA =
        earlierTenkan === null || earlierKijun === null ? null : (earlierTenkan + earlierKijun) / 2;
      const ready = tenkan !== null && kijun !== null && spanA !== null && spanB !== null;
      const future = ready ? [(tenkan + kijun) / 2, middle(i, spanBPeriod)] : [null, null];
      const top = ready ? Math.max(spanA, spanB) : null;
      const bottom = ready ? Math.min(spanA, spanB) : null;
      reference.tenkan.push(ready ? tenkan : null);
      reference.kijun.push(ready ? kijun : null);
      reference.spanA.push(ready ? spanA : null);
      reference.spanB.push(ready ? spanB : null);
      reference.futureSpanA.push(future[0] ?? null);
      reference.futureSpanB.push(future[1] ?? null);
      reference.cloudTop.push(top);
      reference.cloudBottom.push(bottom);
      reference.chikouDelta.push(ready ? bar.c - at(CLOSES, earlier) : null);
      positions.push(
        top === null || bottom === null
          ? null
          : bar.c > top
            ? 'ABOVE'
            : bar.c < bottom
              ? 'BELOW'
              : 'INSIDE',
      );
    });
    for (const key of Object.keys(reference) as (keyof typeof reference)[]) {
      expectSame(
        ours.map((v) => v?.[key] ?? null),
        reference[key],
        500,
      );
    }
    expect(ours.map((v) => v?.position ?? null)).toEqual(positions);
    expect(new Set(positions).size).toBeGreaterThanOrEqual(3);
  });

  it('realised volatility(20) from log returns', () => {
    const returns = CLOSES.map((v, i) => (i === 0 ? 0 : Math.log(v / at(CLOSES, i - 1))));
    const reference = CLOSES.map((_, i) =>
      i < 20 ? null : Math.sqrt(mean(returns.slice(i - 19, i + 1).map((r) => r * r))),
    );
    expectSame(computeSeries(new RealisedVolatility(20), CLOSES), reference);
  });

  it('Garman-Klass volatility(20) from the per-candle estimator', () => {
    const variance = BARS.map(
      (b) => 0.5 * Math.log(b.h / b.l) ** 2 - (2 * Math.LN2 - 1) * Math.log(b.c / b.o) ** 2,
    );
    const reference = BARS.map((_, i) =>
      i < 19 ? null : Math.sqrt(Math.max(0, mean(variance.slice(i - 19, i + 1)))),
    );
    expectSame(computeSeries(new GarmanKlass(20), BARS), reference);
  });

  it('anchored mean: the two-pass weighted mean and deviation, and again after re-anchoring', () => {
    const random = mulberry32(5);
    const inputs = BARS.map((b) => ({
      h: b.h,
      l: b.l,
      c: b.c,
      weight: 1 + Math.floor(random() * 40),
    }));
    const typical = inputs.map((b) => (b.h + b.l + b.c) / 3);
    const anchor = 400;
    const twoPass = (from: number, to: number) => {
      const weights = inputs.slice(from, to + 1).map((b) => b.weight);
      const prices = typical.slice(from, to + 1);
      const total = sum(weights);
      const centre = sum(prices.map((p, k) => p * at(weights, k))) / total;
      const spread = sum(prices.map((p, k) => at(weights, k) * (p - centre) ** 2)) / total;
      return { centre, deviation: Math.sqrt(spread), total };
    };

    const indicator = new AnchoredMean();
    inputs.forEach((input, i) => {
      if (i === anchor) indicator.reset();
      const value = indicator.update(input);
      const expected = twoPass(i < anchor ? 0 : anchor, i);
      expect(Math.abs((value?.mean ?? Number.NaN) - expected.centre)).toBeLessThan(TOLERANCE);
      expect(Math.abs((value?.deviation ?? Number.NaN) - expected.deviation)).toBeLessThan(1e-7);
      expect(value?.totalWeight).toBe(expected.total);
    });
  });
});
