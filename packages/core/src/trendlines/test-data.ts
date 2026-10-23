import { mulberry32 } from '../candles/test-fixtures';
import { FIVE_MINUTES, at, pivot } from '../levels/test-data';
import type { Pivot, StructureCandle } from '../structure/types';
import { lineValueAt, type LineSide, type Trendline } from './lines';

export { FIVE_MINUTES, at, pivot };

export const BASE = at('2026-10-21T00:00');
export const when = (index: number, base = BASE) => base + index * FIVE_MINUTES;

/** Candles 0..count-1 of a 5-minute series: open = close = `close(i)`, wicks 0.1. */
export function closeSeries(
  count: number,
  close: (index: number) => number,
  base = BASE,
): StructureCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const c = close(i);
    return { openTime: when(i, base), o: c, h: c + 0.1, l: c - 0.1, c };
  });
}

export function bar(index: number, o: number, h: number, l: number, c: number): StructureCandle {
  return { openTime: when(index), o, h, l, c };
}

/** The same candle in a mirror around `around` (up becomes down). */
export function mirrorBar(candle: StructureCandle, around = 220): StructureCandle {
  return {
    openTime: candle.openTime,
    o: around - candle.o,
    h: around - candle.l,
    l: around - candle.h,
    c: around - candle.c,
  };
}

/**
 * A line through two swing points as the detector would report it, for tests of the break and
 * retest code. Support: lows (aIdx, aPrice) and (bIdx, bPrice). Resistance: the same numbers
 * mirrored around 220.
 */
export function makeLine(
  side: LineSide,
  a: [index: number, price: number],
  b: [index: number, price: number],
): Trendline {
  const flip = (price: number) => (side === 'SUPPORT' ? price : 220 - price);
  const kind = side === 'SUPPORT' ? 'LOW' : 'HIGH';
  const first: Pivot = pivot(kind, flip(a[1]), a[0]);
  const second: Pivot = pivot(kind, flip(b[1]), b[0]);
  return {
    id: `T${side === 'SUPPORT' ? 'S' : 'R'}:${String(a[0])}:${String(b[0])}`,
    side,
    a: first,
    b: second,
    slope: (second.price - first.price) / (b[0] - a[0]),
    candleMs: FIVE_MINUTES,
    touchPoints: [first, second],
    touches: 2,
    confirmed: false,
    length: b[0] - a[0],
    lastTouchIndex: b[0],
    score: 0,
  };
}

export { lineValueAt };

/**
 * A seeded random walk with a drift per candle, bursts and wicks of up to 0.5, so lines of both
 * sides occur. `skip` removes that many candles from `skipAt` on, which leaves a gap in the series.
 */
export function driftCandles(
  seed: number,
  count: number,
  drift: number,
  skip: { at: number; count: number } | null = null,
  start = 4000,
): StructureCandle[] {
  const random = mulberry32(seed);
  const candles: StructureCandle[] = [];
  let close = start;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    const burst = random() < 0.1 ? 2.5 : 1;
    close = open + drift + (random() - 0.5) * 1.4 * burst;
    const candle: StructureCandle = {
      openTime: when(i),
      o: open,
      h: Math.max(open, close) + random() * 0.5,
      l: Math.min(open, close) - random() * 0.5,
      c: close,
    };
    if (!skip || i < skip.at || i >= skip.at + skip.count) candles.push(candle);
  }
  return candles;
}
