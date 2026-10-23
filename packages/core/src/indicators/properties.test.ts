import { describe, expect, it } from 'vitest';

import { Ema, Hull, Sma, Wma } from './averages';
import { closes, randomBars } from './test-data';
import {
  Aroon,
  EfficiencyRatio,
  HeikinAshi,
  LinearRegression,
  ParabolicSar,
  Supertrend,
} from './trend';
import { type Bar, type Indicator, computeSeries } from './types';
import {
  Atr,
  Bollinger,
  Choppiness,
  Donchian,
  Keltner,
  PercentileRank,
  Squeeze,
  TrueRange,
} from './volatility';

interface Case {
  readonly name: string;
  readonly make: () => Indicator<never, unknown>;
  readonly input: 'bar' | 'close';
}

// Every indicator, with the settings the engine uses.
const CASES: readonly Case[] = [
  { name: 'Sma(20)', make: () => new Sma(20), input: 'close' },
  { name: 'Ema(20)', make: () => new Ema(20), input: 'close' },
  { name: 'Wma(20)', make: () => new Wma(20), input: 'close' },
  { name: 'Hull(20)', make: () => new Hull(20), input: 'close' },
  { name: 'TrueRange', make: () => new TrueRange(), input: 'bar' },
  { name: 'Atr(14)', make: () => new Atr(), input: 'bar' },
  { name: 'Bollinger(20, 2)', make: () => new Bollinger(), input: 'close' },
  { name: 'Keltner(20, 1.5)', make: () => new Keltner(), input: 'bar' },
  { name: 'Donchian(20)', make: () => new Donchian(20), input: 'bar' },
  { name: 'Donchian(55)', make: () => new Donchian(55), input: 'bar' },
  { name: 'Choppiness(14)', make: () => new Choppiness(), input: 'bar' },
  { name: 'Squeeze', make: () => new Squeeze(), input: 'bar' },
  { name: 'PercentileRank(100)', make: () => new PercentileRank(100), input: 'close' },
  { name: 'Supertrend(10, 3)', make: () => new Supertrend(), input: 'bar' },
  { name: 'ParabolicSar', make: () => new ParabolicSar(), input: 'bar' },
  { name: 'Aroon(25)', make: () => new Aroon(), input: 'bar' },
  { name: 'HeikinAshi', make: () => new HeikinAshi(), input: 'bar' },
  { name: 'EfficiencyRatio(20)', make: () => new EfficiencyRatio(), input: 'close' },
  { name: 'LinearRegression(20)', make: () => new LinearRegression(20), input: 'close' },
];

const BARS = randomBars(2026, 700);

function inputsOf(kind: Case['input'], bars: readonly Bar[]): never[] {
  return (kind === 'bar' ? bars : closes(bars)) as never[];
}

function run(testCase: Case, bars: readonly Bar[]): unknown[] {
  return computeSeries(testCase.make(), inputsOf(testCase.input, bars));
}

describe.each(CASES)('$name', (testCase) => {
  it('gives the same values one by one and as a batch (incremental equals batch)', () => {
    const indicator = testCase.make();
    const oneByOne = inputsOf(testCase.input, BARS).map((input) => indicator.update(input));
    expect(JSON.stringify(oneByOne)).toBe(JSON.stringify(run(testCase, BARS)));
  });

  it('never looks ahead: the values over a truncated history equal the start of the full run', () => {
    const full = run(testCase, BARS);
    for (const cut of [60, 200, 431]) {
      expect(JSON.stringify(run(testCase, BARS.slice(0, cut)))).toBe(
        JSON.stringify(full.slice(0, cut)),
      );
    }
  });

  it('has no value before its warm-up and one from then on', () => {
    const indicator = testCase.make();
    const values = computeSeries(indicator, inputsOf(testCase.input, BARS));
    const first = values.findIndex((v) => v !== null);
    expect(first + 1).toBe(indicator.warmup);
    expect(values.slice(first).every((v) => v !== null)).toBe(true);
    expect(indicator.count).toBe(BARS.length);
    expect(indicator.value).toEqual(values.at(-1));
  });

  it('is deterministic: the same candles always give the same bytes', () => {
    expect(JSON.stringify(run(testCase, BARS))).toBe(JSON.stringify(run(testCase, BARS)));
  });

  it('refuses a candle or value that is not a finite number', () => {
    const indicator = testCase.make();
    const bad = testCase.input === 'bar' ? { o: 1, h: Number.NaN, l: 1, c: 1 } : Number.NaN;
    expect(() => (indicator as Indicator<unknown, unknown>).update(bad)).toThrow(RangeError);
  });
});
