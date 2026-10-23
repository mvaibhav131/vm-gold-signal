import { mulberry32 } from '../candles/test-fixtures';
import type { LiquidityLevel } from './sweeps';
import type { StructureCandle } from './types';

export const FIVE_MINUTES = 300_000;
export const T0 = Date.UTC(2026, 0, 5, 8, 0, 0);

export type Row = readonly [o: number, h: number, l: number, c: number];

/** Candles from `[open, high, low, close]` rows, 5 minutes apart. */
export function series(rows: readonly Row[], startIndex = 0): StructureCandle[] {
  return rows.map(([o, h, l, c], i) => ({
    openTime: T0 + (startIndex + i) * FIVE_MINUTES,
    o,
    h,
    l,
    c,
  }));
}

/** One candle at position `index` of a 5-minute series. */
export function candleAt(
  index: number,
  o: number,
  h: number,
  l: number,
  c: number,
): StructureCandle {
  return { openTime: T0 + index * FIVE_MINUTES, o, h, l, c };
}

/** A candle with only a high and a low (open and close at the middle). */
export function spanAt(index: number, h: number, l: number): StructureCandle {
  const mid = (h + l) / 2;
  return candleAt(index, mid, h, l, mid);
}

/**
 * A price path that turns exactly at the given points, `steps` candles per leg. The first candle
 * sits at the first point; every later candle opens at the close before it. Wicks are chosen so
 * that the candle at each turning point has the strictly highest high (or lowest low) of its
 * neighbourhood: an up candle has a 0.4 upper and 0.1 lower wick, a down candle 0.1 and 0.4. With
 * `steps` of 3 or more and k = 2, the pivots are exactly the turning points at indexes
 * `steps x n`, priced 0.4 above (highs) or below (lows) the point, confirmed 2 candles later.
 */
export function zigzag(points: readonly number[], steps = 3): StructureCandle[] {
  const first = points[0] ?? 0;
  const rows: Row[] = [[first, first + 0.1, first - 0.1, first]];
  let previous = first;
  for (let leg = 1; leg < points.length; leg += 1) {
    const target = points[leg] ?? previous;
    const from = previous;
    for (let step = 1; step <= steps; step += 1) {
      const close = from + ((target - from) * step) / steps;
      const open = previous;
      rows.push(
        close >= open
          ? [open, close + 0.4, open - 0.1, close]
          : [open, open + 0.1, close - 0.4, close],
      );
      previous = close;
    }
  }
  return series(rows);
}

/** The same path seen in a mirror (up becomes down). */
export function mirrored(points: readonly number[], around = 230): number[] {
  return points.map((p) => around - p);
}

/**
 * A seeded random walk with bursts, so that every primitive (displacement, gaps, breaks) occurs.
 * Wicks are up to 0.5; about one candle in eight moves three times as far.
 */
export function randomCandles(seed: number, count: number, start = 4000): StructureCandle[] {
  const random = mulberry32(seed);
  const candles: StructureCandle[] = [];
  let close = start;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    const burst = random() < 0.125 ? 3 : 1;
    close = open + (random() - 0.5) * 1.6 * burst + Math.sin(i / 25) * 0.1;
    const high = Math.max(open, close) + random() * 0.5;
    const low = Math.min(open, close) - random() * 0.5;
    candles.push({ openTime: T0 + i * FIVE_MINUTES, o: open, h: high, l: low, c: close });
  }
  return candles;
}

/** A grid of liquidity levels covering the whole price range of the candles (both sides at every price). */
export function levelGrid(candles: readonly StructureCandle[], step = 0.3): LiquidityLevel[] {
  const low = Math.min(...candles.map((c) => c.l));
  const high = Math.max(...candles.map((c) => c.h));
  const levels: LiquidityLevel[] = [];
  for (let price = Math.ceil(low / step) * step; price <= high; price += step) {
    const key = price.toFixed(3);
    levels.push({ id: `L${key}`, side: 'LOW', price }, { id: `H${key}`, side: 'HIGH', price });
  }
  return levels;
}

/** An up trend that turns into a range and then a down trend (see breaks.test.ts for the events). */
export const TREND_POINTS: readonly number[] = [
  100, 110, 104, 114, 108, 118, 112, 122, 116, 126, 112, 120, 104, 112,
];
