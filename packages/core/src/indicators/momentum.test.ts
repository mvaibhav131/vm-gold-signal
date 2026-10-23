import { describe, expect, it } from 'vitest';

import { AwesomeOscillator, Cci, Change, Macd, Roc, Rsi, StochRsi, WilliamsR } from './momentum';
import { bar, round, roundAll, span } from './test-data';
import { computeSeries } from './types';

describe('Rsi', () => {
  it('follows Wilder smoothing (hand-checked, period 3)', () => {
    // changes +1 -1 +2: average gain 1, average loss 1/3 -> RS 3 -> 75.
    // then -1: gain 2/3, loss 5/9 -> RS 1.2 -> 54.5455; then +2: gain 10/9, loss 10/27 -> RS 3 -> 75.
    expect(roundAll(computeSeries(new Rsi(3), [10, 11, 10, 12, 11, 13]), 4)).toEqual([
      null,
      null,
      null,
      75,
      54.5455,
      75,
    ]);
  });

  it('needs period + 1 closes', () => {
    expect(new Rsi(14).warmup).toBe(15);
    expect(new Rsi().period).toBe(14);
  });

  it('is 100 when nothing fell, 0 when nothing rose, and neutral when nothing moved', () => {
    expect(computeSeries(new Rsi(3), [1, 2, 3, 4, 5]).at(-1)).toBe(100);
    expect(computeSeries(new Rsi(3), [5, 4, 3, 2, 1]).at(-1)).toBe(0);
    expect(computeSeries(new Rsi(3), [7, 7, 7, 7, 7]).at(-1)).toBe(50);
  });

  it('rejects a period below 1', () => {
    expect(() => new Rsi(0)).toThrow(RangeError);
  });
});

describe('StochRsi', () => {
  it('places the RSI inside its own range (hand-checked, rsi 2, stoch 2, no smoothing)', () => {
    // RSI(2) of [10,11,10,12,11,13] is 50, 83.33, 50, 80.77 from index 2; windows of 2 give 100, 0, 100.
    const values = computeSeries(new StochRsi(2, 2, 1, 1), [10, 11, 10, 12, 11, 13]);
    expect(values.map((v) => v?.raw ?? null)).toEqual([null, null, null, 100, 0, 100]);
    expect(values.map((v) => v?.k ?? null)).toEqual([null, null, null, 100, 0, 100]);
    expect(values.map((v) => v?.d ?? null)).toEqual([null, null, null, 100, 0, 100]);
  });

  it('smooths %K and then %D with simple averages, and waits for all of them', () => {
    const indicator = new StochRsi(2, 2, 2, 2);
    expect(indicator.warmup).toBe(6);
    const values = computeSeries(indicator, [10, 11, 10, 12, 11, 13, 14]);
    // raw 100, 0, 100, 100 from index 3; %K = mean of 2 raw: 50, 50, 100 from index 4;
    // %D = mean of 2 %K: 50, 75 from index 5
    expect(values.findIndex((v) => v !== null)).toBe(5);
    expect(values[5]).toEqual({ raw: 100, k: 50, d: 50 });
    expect(values[6]).toEqual({ raw: 100, k: 100, d: 75 });
  });

  it('is neutral when the RSI has no range', () => {
    const values = computeSeries(new StochRsi(3, 3, 1, 1), [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(values.at(-1)).toEqual({ raw: 50, k: 50, d: 50 });
  });

  it('uses the documented defaults', () => {
    const indicator = new StochRsi();
    expect(indicator.warmup).toBe(15 + 13 + 2 + 2);
  });
});

describe('Macd', () => {
  it('is fast EMA - slow EMA, a signal EMA of it, and their gap (hand-checked, 2/3/2)', () => {
    const values = computeSeries(new Macd(2, 3, 2), [1, 4, 9, 16, 25, 36, 49]);
    expect(values.slice(0, 3).every((v) => v === null)).toBe(true);
    expect(round(values[3]?.macd ?? null, 4)).toBe(2.6111);
    expect(round(values[3]?.signal ?? null, 4)).toBe(2.3889);
    expect(round(values[3]?.histogram ?? null, 4)).toBe(0.2222);
    expect(values[3]?.histogramChange).toBeNull();
    expect(values.slice(3).map((v) => round(v?.macd ?? null, 4))).toEqual([
      2.6111, 3.3148, 4.1605, 5.0813,
    ]);
    expect(values.slice(3).map((v) => round(v?.signal ?? null, 4))).toEqual([
      2.3889, 3.0062, 3.7757, 4.6461,
    ]);
    expect(values.slice(3).map((v) => round(v?.histogram ?? null, 4))).toEqual([
      0.2222, 0.3086, 0.3848, 0.4352,
    ]);
    expect(values.slice(4).map((v) => round(v?.histogramChange ?? null, 4))).toEqual([
      0.0864, 0.0761, 0.0504,
    ]);
  });

  it('needs slow + signal - 1 closes and uses 12/26/9 by default', () => {
    expect(new Macd().warmup).toBe(34);
  });

  it('is zero for a flat series', () => {
    const last = computeSeries(
      new Macd(),
      Array.from({ length: 60 }, () => 4000),
    ).at(-1);
    expect(last).toEqual({ macd: 0, signal: 0, histogram: 0, histogramChange: 0 });
  });

  it('refuses a fast period that is not shorter than the slow one', () => {
    expect(() => new Macd(26, 12, 9)).toThrow(RangeError);
    expect(() => new Macd(12, 12, 9)).toThrow(RangeError);
  });
});

describe('Roc', () => {
  it('is the percentage change over n candles (hand-checked)', () => {
    expect(computeSeries(new Roc(1), [100, 110, 121])).toEqual([null, 10, 10]);
    expect(roundAll(computeSeries(new Roc(2), [100, 110, 121]))).toEqual([null, null, 21]);
    expect(computeSeries(new Roc(1), [200, 100])).toEqual([null, -50]);
  });

  it('is 0 instead of infinity when the base is 0', () => {
    expect(computeSeries(new Roc(1), [0, 5])).toEqual([null, 0]);
  });
});

describe('Change', () => {
  it('is the difference to the value n inputs ago', () => {
    expect(computeSeries(new Change(2), [1, 4, 9, 16])).toEqual([null, null, 8, 12]);
    expect(new Change(3).warmup).toBe(4);
  });
});

describe('Cci', () => {
  it('is (typical - mean) / (0.015 x mean deviation) (hand-checked)', () => {
    // typical prices 1, 2, 6: mean 3, mean deviation (2 + 1 + 3) / 3 = 2 -> (6 - 3) / 0.03 = 100.
    const values = computeSeries(new Cci(3), [bar(1, 1, 1, 1), bar(2, 2, 2, 2), bar(6, 6, 6, 6)]);
    expect(values.slice(0, 2)).toEqual([null, null]);
    expect(round(values[2] ?? null)).toBe(100);
  });

  it('uses (high + low + close) / 3', () => {
    // typical 3 (h 4, l 1, c 4 -> 3), 3, 3 -> no deviation -> 0
    const same = bar(3, 4, 1, 4);
    expect(computeSeries(new Cci(3), [same, same, same]).at(-1)).toBe(0);
  });

  it('has 20 as the default period', () => {
    expect(new Cci().warmup).toBe(20);
  });
});

describe('WilliamsR', () => {
  it('is -100 x (highest high - close) / range (hand-checked)', () => {
    // highs 10, 12, 11 and lows 8, 9, 7: range 12 - 7 = 5; close 10 -> -100 x 2 / 5 = -40
    const values = computeSeries(new WilliamsR(3), [
      bar(9, 10, 8, 9),
      bar(10, 12, 9, 11),
      bar(10, 11, 7, 10),
    ]);
    expect(values).toEqual([null, null, -40]);
  });

  it('is 0 at the high, -100 at the low, and -50 with no range', () => {
    const at = (close: number) =>
      computeSeries(new WilliamsR(2), [bar(1, 10, 0, 5), bar(5, 10, 0, close)]).at(-1);
    expect(at(10)).toBe(0);
    expect(at(0)).toBe(-100);
    const flat = bar(5, 5, 5, 5);
    expect(computeSeries(new WilliamsR(2), [flat, flat]).at(-1)).toBe(-50);
  });
});

describe('AwesomeOscillator', () => {
  it('is SMA(fast) - SMA(slow) of the median price (hand-checked, 2/3)', () => {
    // medians 2, 4, 6, 8: SMA2 5, SMA3 4 -> 1; SMA2 7, SMA3 6 -> 1
    const bars = [span(3, 1), span(5, 3), span(7, 5), span(9, 7)];
    expect(computeSeries(new AwesomeOscillator(2, 3), bars)).toEqual([null, null, 1, 1]);
  });

  it('needs 34 candles by default and refuses fast >= slow', () => {
    expect(new AwesomeOscillator().warmup).toBe(34);
    expect(() => new AwesomeOscillator(5, 5)).toThrow(RangeError);
  });
});
