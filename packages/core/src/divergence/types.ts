import type { Direction } from '../structure/types';

/** Which oscillator the price swing points are compared with. */
export type DivergenceSource = 'RSI' | 'MACD_HISTOGRAM';

/** Regular divergence suggests a reversal (price makes a new extreme, the oscillator does not); hidden suggests that the trend goes on. */
export type DivergenceKind = 'REGULAR' | 'HIDDEN';

/** Thresholds of `strategy-config v0.1.0` (docs/02 section 4.1). They are hypotheses, tuned only on training data. */
export interface DivergenceParams {
  /** The two swing points are at least this many and at most `maxSpan` candles apart. */
  readonly minSpan: number;
  readonly maxSpan: number;
  /**
   * A regular divergence needs the oscillator at the first swing point to be in this zone: at most
   * `low` for a bullish one (swing lows), at least `high` for a bearish one (swing highs).
   */
  readonly zone: Readonly<
    Record<DivergenceSource, { readonly low: number; readonly high: number }>
  >;
}

export const DIVERGENCE_DEFAULTS: DivergenceParams = {
  minSpan: 5,
  maxSpan: 40,
  zone: { RSI: { low: 40, high: 60 }, MACD_HISTOGRAM: { low: 0, high: 0 } },
};

/** A swing point with the value of the oscillator at its candle. */
export interface DivergencePoint {
  readonly index: number;
  readonly openTime: number;
  /** Price of the swing point (the high or low of its candle). */
  readonly price: number;
  /** The oscillator at the close of the swing point's candle. */
  readonly value: number;
}

export interface Divergence {
  /** Stable id: timeframe tag, source, kind, direction and the indexes of the two swing points. */
  readonly id: string;
  readonly source: DivergenceSource;
  readonly kind: DivergenceKind;
  /** `UP` is bullish (swing lows) and `DOWN` bearish (swing highs). */
  readonly direction: Direction;
  readonly first: DivergencePoint;
  readonly second: DivergencePoint;
  /** The candle on which it became known: the one that confirmed the second swing point. */
  readonly index: number;
  readonly openTime: number;
}
