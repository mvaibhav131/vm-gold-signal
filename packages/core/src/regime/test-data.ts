import type { StructureCandle } from '../structure/types';
import type { RegimeParams } from './types';
import { REGIME_DEFAULTS } from './types';

export const HOUR_MS = 3_600_000;
export const QUARTER_MS = 900_000;
export const T0 = Date.UTC(2026, 0, 5, 8, 0, 0);

/** A repeatable stream of numbers in [0, 1) (mulberry32): fixtures that never change and need no Math.sin or Math.log. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Candles that follow a path of closes. Each opens at the previous close (the first at its own
 * close) and reaches `wick` beyond its body on both sides; `wick` can depend on the candle.
 */
export function fromCloses(
  closes: readonly number[],
  stepMs: number,
  wick: number | ((index: number) => number) = 0.1,
  startIndex = 0,
): StructureCandle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : (closes[i - 1] ?? c);
    const w = typeof wick === 'number' ? wick : wick(i);
    return {
      openTime: T0 + (startIndex + i) * stepMs,
      o,
      h: Math.max(o, c) + w,
      l: Math.min(o, c) - w,
      c,
    };
  });
}

/** A path that starts at `start` and moves by the given steps. */
export function walk(start: number, steps: readonly number[]): number[] {
  const closes: number[] = [];
  let price = start;
  for (const step of steps) {
    price += step;
    closes.push(price);
  }
  return closes;
}

/** The 1h trend values are far from every threshold in these three: a steady climb, a steady fall, and a swing in place. */
export const hourlyUp = (count: number, step = 2): StructureCandle[] =>
  fromCloses(
    walk(
      4000,
      Array.from({ length: count }, () => step),
    ),
    HOUR_MS,
  );

export const hourlyDown = (count: number, step = 2): StructureCandle[] => hourlyUp(count, -step);

const SWING = [3, -1, 2, -4, 1, -1];
export const hourlySideways = (count: number): StructureCandle[] =>
  fromCloses(
    walk(
      4000,
      Array.from({ length: count }, (_, i) => SWING[i % SWING.length] ?? 0),
    ),
    HOUR_MS,
  );

/** Noisy history with a spread of volatilities, so that the ATR percentile of its end is not degenerate. */
export function noisyQuarterSteps(seed: number, count: number): number[] {
  const next = random(seed);
  return Array.from({ length: count }, () => (next() - 0.5) * 6 * (0.4 + next()));
}

/** 1h closes scattered around 4000 without a direction (seeded). With `SMALL`, seed 22 has an ADX of 16.6. */
export function hourlyNoise(seed: number, count = 40): StructureCandle[] {
  const next = random(seed);
  const closes = Array.from({ length: count }, () => 4000 + (next() - 0.5) * 8);
  return fromCloses(closes, HOUR_MS, () => next() * 1.5);
}

/** Smaller periods, so that a fixture of 60 candles is enough. The thresholds are the real ones. */
export const SMALL: RegimeParams = {
  ...REGIME_DEFAULTS,
  periods: { emaFast: 3, emaMid: 6, emaSlow: 12, adx: 5, efficiency: 6, atr: 5 },
  highVol: { ...REGIME_DEFAULTS.highVol, window: 30 },
};

/** Sixty 15m candles of noise with all sorts of ranges: the history that every 15m scenario starts from. */
export const HISTORY: readonly number[] = noisyQuarterSteps(7, 60);

/** Steps that alternate by 0.05: the market is asleep. */
export const calm = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05));

/** A 15m scenario: the steps after `HISTORY` and the wick of each candle (index counted from the start). */
export interface QuarterScenario {
  readonly steps: readonly number[];
  readonly wick: number | ((index: number) => number);
}

/** Candles with a wick of 0.5 while the history runs and almost none after it. */
const QUIET_AFTER_HISTORY = (index: number) => (index < HISTORY.length ? 0.5 : 0.02);

const RANGE_CYCLE = [3, 3, 0, -3, -3, 0];

export const QUARTER = {
  /** A slow, steady slide: ATR at its lowest, a wide range, no squeeze. Nothing in it fits a regime. */
  drift: {
    steps: [...HISTORY, ...Array.from({ length: 30 }, (_, i) => 3 - (2 * i) / 30)],
    wick: 0,
  },
  /** Thirty-two sleeping candles after the noise: the bands move inside the channel for 15 candles. */
  squeeze: { steps: [...HISTORY, ...calm(32)], wick: QUIET_AFTER_HISTORY },
  /** The same, then a big candle (up by `jump`) that releases the squeeze, then `after` sleeping candles. */
  breakout: (jump: number, after: number): QuarterScenario => ({
    steps: [...HISTORY, ...calm(30), jump, ...calm(after)],
    wick: QUIET_AFTER_HISTORY,
  }),
  /** Eight violent candles: ATR is the highest of its window. */
  highVol: { steps: [...HISTORY, 9, -9, 9, -9, 9, -9, 9, -9], wick: 0.5 },
  /** A swing of 6 that repeats every 6 candles: the width of 24 candles is below 3 ATR and the bands stay outside the channel. */
  range: {
    steps: [...HISTORY, ...Array.from({ length: 36 }, (_, i) => RANGE_CYCLE[i % 6] ?? 0)],
    wick: 0.4,
  },
} as const;

export function quarterCandles(scenario: QuarterScenario): StructureCandle[] {
  return fromCloses(walk(4000, scenario.steps), QUARTER_MS, scenario.wick);
}
