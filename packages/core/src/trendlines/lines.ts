import { TOLERANCE, type Pivot, type StructureCandle } from '../structure/types';
import { TRENDLINE_DEFAULTS, type TrendlineParams } from './types';

/** A rising line under the lows, or a falling line over the highs. */
export type LineSide = 'SUPPORT' | 'RESISTANCE';

export interface Trendline {
  /** For example `15mS:42:60`: timeframe tag, S or R, and the series positions of its two points. */
  readonly id: string;
  readonly side: LineSide;
  /** The earlier and the later swing point the line passes through. */
  readonly a: Pivot;
  readonly b: Pivot;
  /** Price change per candle (positive for support, negative for resistance). */
  readonly slope: number;
  /** Length of a candle of the timeframe the line was drawn on, in milliseconds. */
  readonly candleMs: number;
  /** All the swing points on the line, the two of its definition included, oldest first. */
  readonly touchPoints: readonly Pivot[];
  readonly touches: number;
  /** At least 3 touches. */
  readonly confirmed: boolean;
  /** Candles from the first point to the last touch. */
  readonly length: number;
  readonly lastTouchIndex: number;
  readonly score: number;
}

/** The price of the line at an instant. It is a straight line in time, so it can be read at the candles of any timeframe. */
export function lineValueAt(
  line: Pick<Trendline, 'a' | 'slope' | 'candleMs'>,
  openTime: number,
): number {
  return line.a.price + (line.slope * (openTime - line.a.openTime)) / line.candleMs;
}

export interface TrendlineInput {
  /** The most recent candles of the series, oldest first and in order. At least the last `window` if they exist. */
  readonly candles: readonly StructureCandle[];
  /** How many candles the series has had in all: `candles[i]` is candle number `count - candles.length + i`. */
  readonly count: number;
  /** Confirmed swing points, oldest first. */
  readonly highs: readonly Pivot[];
  readonly lows: readonly Pivot[];
  /** ATR of the same timeframe as of now; null while it warms up (no lines). */
  readonly atr: number | null;
  readonly candleMs: number;
  /** Keeps ids apart between timeframes, for example `15m`. */
  readonly tag?: string;
  readonly params?: TrendlineParams;
}

/**
 * Automatic trendlines (docs/02 section 4.1). A support line passes through two confirmed swing
 * lows A (earlier) and B (later) that are at least 6 candles apart, with B above A and a slope of
 * at most 0.15 x ATR per candle; a resistance line is the mirror image through falling swing
 * highs. Only swing points of the last 80 candles are used. A line is valid when
 *
 * - no candle since A closed beyond it by more than 0.10 x ATR (below a support line, above a
 *   resistance line), and
 * - no swing point of the same kind between A and B lies beyond it by more than 0.15 x ATR.
 *
 * Touches are the swing points of that kind, from A on, within 0.15 x ATR of the line; two are
 * needed and three make it confirmed. Score = 2 x touches + min(length / 10, 3) + recency, where
 * length is the number of candles from A to the last touch and recency is 1 for a touch on the
 * latest candle, falling to 0 over 80 candles. Best first.
 *
 * The ATR is the one given, for all the conditions. A line never crosses a gap in the data (a
 * missing candle, a weekend): swing points before the last gap are not used. Everything is
 * computed from the candles and swing points passed in, so the answer only changes when they do.
 */
export function findTrendlines(input: TrendlineInput): Trendline[] {
  const params = input.params ?? TRENDLINE_DEFAULTS;
  const { atr, candles, count, candleMs } = input;
  if (atr === null || !(atr > 0) || candles.length === 0) return [];

  const firstIndex = count - candles.length;
  let usableFrom = Math.max(firstIndex, count - params.window);
  for (let i = 1; i < candles.length; i += 1) {
    const gap = (candles[i]?.openTime ?? 0) - (candles[i - 1]?.openTime ?? 0) !== candleMs;
    if (gap) usableFrom = Math.max(usableFrom, firstIndex + i);
  }

  const lines: Trendline[] = [];
  for (const side of ['SUPPORT', 'RESISTANCE'] as const) {
    const support = side === 'SUPPORT';
    const points = (support ? input.lows : input.highs).filter((p) => p.index >= usableFrom);
    const maxSlope = params.maxSlopeAtr * atr + TOLERANCE;

    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      if (!a) continue;
      for (let j = i + 1; j < points.length; j += 1) {
        const b = points[j];
        if (!b || b.index - a.index < params.minSpan) continue;
        const slope = (b.price - a.price) / (b.index - a.index);
        if (support ? slope <= 0 : slope >= 0) continue;
        if (Math.abs(slope) > maxSlope) continue;

        const base = { a, slope, candleMs };
        let valid = true;
        for (let c = a.index - firstIndex; c < candles.length && valid; c += 1) {
          const candle = candles[c];
          if (!candle) continue;
          const beyond = support
            ? lineValueAt(base, candle.openTime) - candle.c
            : candle.c - lineValueAt(base, candle.openTime);
          if (beyond > params.invalidCloseAtr * atr + TOLERANCE) valid = false;
        }
        if (!valid) continue;
        for (const p of points) {
          if (p.index <= a.index || p.index >= b.index) continue;
          const beyond = support
            ? lineValueAt(base, p.openTime) - p.price
            : p.price - lineValueAt(base, p.openTime);
          if (beyond > params.betweenAtr * atr + TOLERANCE) valid = false;
        }
        if (!valid) continue;

        const touchPoints = points.filter(
          (p) =>
            p.index >= a.index &&
            Math.abs(p.price - lineValueAt(base, p.openTime)) <= params.touchAtr * atr + TOLERANCE,
        );
        if (touchPoints.length < params.minTouches) continue;

        const lastTouchIndex = touchPoints.at(-1)?.index ?? b.index;
        const length = lastTouchIndex - a.index;
        const recency = Math.max(0, 1 - (count - 1 - lastTouchIndex) / params.window);
        lines.push({
          id: `${input.tag ?? ''}${support ? 'S' : 'R'}:${String(a.index)}:${String(b.index)}`,
          side,
          a,
          b,
          slope,
          candleMs,
          touchPoints,
          touches: touchPoints.length,
          confirmed: touchPoints.length >= params.confirmedTouches,
          length,
          lastTouchIndex,
          score:
            params.touchWeight * touchPoints.length +
            Math.min(length / params.lengthPerPoint, params.lengthCap) +
            recency,
        });
      }
    }
  }
  return lines.sort(
    (x, y) =>
      y.score - x.score ||
      y.lastTouchIndex - x.lastTouchIndex ||
      x.a.index - y.a.index ||
      x.b.index - y.b.index,
  );
}

/** The best line of one side, or null. `lines` as returned by `findTrendlines` (best first). */
export function bestTrendline(lines: readonly Trendline[], side: LineSide): Trendline | null {
  return lines.find((line) => line.side === side) ?? null;
}
