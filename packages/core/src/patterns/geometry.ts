import type { Trendline } from '../trendlines/lines';
import { TOLERANCE, type Pivot, type StructureCandle } from '../structure/types';
import { PATTERN_DEFAULTS, type Boundary, type PatternInput, type PatternParams } from './types';

/** The price of a boundary at an instant. */
export function boundaryAt(boundary: Boundary, openTime: number): number {
  return boundary.price + (boundary.slope * (openTime - boundary.openTime)) / boundary.candleMs;
}

export function horizontal(openTime: number, price: number, candleMs: number): Boundary {
  return { openTime, price, slope: 0, candleMs };
}

export function boundaryOfLine(line: Pick<Trendline, 'a' | 'slope' | 'candleMs'>): Boundary {
  return {
    openTime: line.a.openTime,
    price: line.a.price,
    slope: line.slope,
    candleMs: line.candleMs,
  };
}

/** Where two boundaries meet, as an instant, or null when they are parallel. */
export function apexOf(upper: Boundary, lower: Boundary): number | null {
  const su = upper.slope / upper.candleMs;
  const sl = lower.slope / lower.candleMs;
  if (Math.abs(su - sl) < 1e-15) return null;
  return (lower.price - upper.price + su * upper.openTime - sl * lower.openTime) / (su - sl);
}

/** The distance between the upper and the lower boundary at an instant. */
export function widthAt(upper: Boundary, lower: Boundary, openTime: number): number {
  return boundaryAt(upper, openTime) - boundaryAt(lower, openTime);
}

/**
 * Whether two boundaries compress over a stretch of time: the width over the last third is at most
 * `ratio` times the width over the first third (the widths are straight in time, so these are the
 * widths in the middle of each third), and the boundaries have not met by the end of the stretch.
 */
export function compresses(
  upper: Boundary,
  lower: Boundary,
  startMs: number,
  endMs: number,
  ratio: number,
): boolean {
  const span = endMs - startMs;
  if (!(span > 0)) return false;
  const first = widthAt(upper, lower, startMs + span / 6);
  const last = widthAt(upper, lower, startMs + (5 * span) / 6);
  return first > 0 && widthAt(upper, lower, endMs) > 0 && last <= ratio * first + TOLERANCE;
}

/** Candle number `index` of the series, or undefined when it is not in the candles passed in. */
export function candleOf(input: PatternInput, index: number): StructureCandle | undefined {
  return input.candles[index - (input.count - input.candles.length)];
}

/** The candles of positions `from` to `to`, both included (those that are in the input). */
export function candlesBetween(input: PatternInput, from: number, to: number): StructureCandle[] {
  const offset = input.count - input.candles.length;
  return input.candles.slice(Math.max(0, from - offset), Math.max(0, to - offset + 1));
}

/**
 * The first position that patterns may use: the window, and nothing before the last gap in the
 * data (a missing candle, the weekend), as for trendlines.
 */
export function usableFrom(input: PatternInput, params: PatternParams): number {
  const firstIndex = input.count - input.candles.length;
  let from = Math.max(firstIndex, input.count - params.window);
  for (let i = 1; i < input.candles.length; i += 1) {
    const gap =
      (input.candles[i]?.openTime ?? 0) - (input.candles[i - 1]?.openTime ?? 0) !== input.candleMs;
    if (gap) from = Math.max(from, firstIndex + i);
  }
  return from;
}

export interface FittedBoundary {
  readonly boundary: Boundary;
  readonly a: Pivot;
  readonly b: Pivot;
  readonly touches: readonly Pivot[];
  readonly lastTouchIndex: number;
}

/**
 * The best boundary line through the swing points `points` (highs for an upper boundary, lows for a
 * lower one) of one stretch, whatever its slope. A line through two points at least `minSpan`
 * candles apart is valid under the rules of trendlines: no candle since the first point closed beyond
 * it by more than 0.10 x ATR, and no point between the two is beyond it by more than 0.15 x ATR.
 * Touches are the points from the first one on within 0.15 x ATR. Most touches first, then the
 * longest, then the earliest.
 */
export function fitBoundary(input: {
  readonly side: 'UPPER' | 'LOWER';
  readonly points: readonly Pivot[];
  readonly pattern: PatternInput;
  readonly atr: number;
  readonly minSpan: number;
}): FittedBoundary | null {
  const params = input.pattern.params ?? PATTERN_DEFAULTS;
  const upper = input.side === 'UPPER';
  const { atr } = input;
  const candleMs = input.pattern.candleMs;
  let best: FittedBoundary | null = null;

  for (let i = 0; i < input.points.length; i += 1) {
    const a = input.points[i];
    if (!a) continue;
    for (let j = i + 1; j < input.points.length; j += 1) {
      const b = input.points[j];
      if (!b || b.index - a.index < input.minSpan) continue;
      const slope = (b.price - a.price) / (b.index - a.index);
      const boundary: Boundary = { openTime: a.openTime, price: a.price, slope, candleMs };
      const beyond = (price: number, openTime: number) =>
        upper ? price - boundaryAt(boundary, openTime) : boundaryAt(boundary, openTime) - price;

      let valid = true;
      for (const candle of candlesBetween(input.pattern, a.index, input.pattern.count - 1)) {
        if (beyond(candle.c, candle.openTime) > params.boundary.invalidCloseAtr * atr + TOLERANCE) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      for (const p of input.points) {
        if (p.index <= a.index || p.index >= b.index) continue;
        if (beyond(p.price, p.openTime) > params.boundary.betweenAtr * atr + TOLERANCE)
          valid = false;
      }
      if (!valid) continue;

      const touches = input.points.filter(
        (p) =>
          p.index >= a.index &&
          Math.abs(p.price - boundaryAt(boundary, p.openTime)) <=
            params.boundary.touchAtr * atr + TOLERANCE,
      );
      const lastTouchIndex = touches.at(-1)?.index ?? b.index;
      const better =
        best === null ||
        touches.length > best.touches.length ||
        (touches.length === best.touches.length &&
          lastTouchIndex - a.index > best.lastTouchIndex - best.a.index);
      if (better) best = { boundary, a, b, touches, lastTouchIndex };
    }
  }
  return best;
}
