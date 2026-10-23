import { mulberry32 } from '../candles/test-fixtures';
import type { Bar } from '../indicators/types';
import type { StructureCandle } from '../structure/types';
import { when } from '../trendlines/test-data';

/** A candle from its open and close with wicks of `wick` on both sides. */
export const k = (o: number, c: number, wick = 0.1): Bar => ({
  o,
  h: Math.max(o, c) + wick,
  l: Math.min(o, c) - wick,
  c,
});

/** A candle from all four prices. */
export const ohlc = (o: number, h: number, l: number, c: number): Bar => ({ o, h, l, c });

/** The same candle in a mirror around `around` (up becomes down). */
export const mirror = (b: Bar, around = 220): Bar => ({
  o: around - b.o,
  h: around - b.l,
  l: around - b.h,
  c: around - b.c,
});

/** 5-minute candles numbered from `start`. */
export function timed(bars: readonly Bar[], start = 0): StructureCandle[] {
  return bars.map((b, i) => ({ ...b, openTime: when(start + i) }));
}

/** A seeded random walk with bursts and wicks (prices not rounded, so no two thresholds tie by accident). */
export function randomBars(seed: number, count: number, start = 4000): Bar[] {
  const random = mulberry32(seed);
  const bars: Bar[] = [];
  let close = start;
  for (let i = 0; i < count; i += 1) {
    const open = random() < 0.2 ? close + (random() - 0.5) * 0.4 : close;
    const burst = random() < 0.15 ? 3 : 1;
    close = open + (random() - 0.5) * 1.6 * burst;
    const long = random() < 0.2 ? 2.5 : 1;
    bars.push({
      o: open,
      h: Math.max(open, close) + random() * 0.5 * long,
      l: Math.min(open, close) - random() * 0.5 * long,
      c: close,
    });
  }
  return bars;
}
