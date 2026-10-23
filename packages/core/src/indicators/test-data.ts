import { mulberry32 } from '../candles/test-fixtures';
import type { Bar } from './types';

/** A bar whose open and close are given; high and low are the extremes of both plus the wicks. */
export function bar(o: number, h: number, l: number, c: number): Bar {
  return { o, h, l, c };
}

/** A bar with only a high and a low (open and close at the midpoint). */
export function span(h: number, l: number): Bar {
  const mid = (h + l) / 2;
  return { o: mid, h, l, c: mid };
}

/** A seeded random walk of candles around 4000 (about 0.8 per candle, wicks up to 0.6). */
export function randomBars(seed: number, count: number, start = 4000): Bar[] {
  const random = mulberry32(seed);
  const bars: Bar[] = [];
  let close = start;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    close = open + (random() - 0.5) * 1.6 + Math.sin(i / 40) * 0.15;
    const high = Math.max(open, close) + random() * 0.6;
    const low = Math.min(open, close) - random() * 0.6;
    bars.push({ o: open, h: high, l: low, c: close });
  }
  return bars;
}

export const closes = (bars: readonly Bar[]): number[] => bars.map((b) => b.c);

/** Rounds away binary noise so hand-calculated vectors can be compared with `toEqual`. */
export function round(value: number | null, decimals = 9): number | null {
  return value === null ? null : Number(value.toFixed(decimals));
}

export const roundAll = (values: readonly (number | null)[], decimals = 9): (number | null)[] =>
  values.map((v) => round(v, decimals));
