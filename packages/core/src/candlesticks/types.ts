import type { Direction } from '../structure/types';

export type CandlePatternName =
  'PIN_BAR' | 'ENGULFING' | 'INSIDE_BAR' | 'NR7' | 'MORNING_STAR' | 'EVENING_STAR';

/** Thresholds of `strategy-config v0.1.0` (docs/02 section 4.1). They are hypotheses, tuned only on training data. */
export interface CandleParams {
  readonly pinBar: {
    /** The wick must be at least this many times the body. */
    readonly wickToBody: number;
    /** The wick must be at least this share of the range. */
    readonly wickShare: number;
    /** The close must be inside this share of the range at the far end from the wick. */
    readonly closeZone: number;
  };
  readonly engulfing: { readonly minRangeAtr: number };
  /** The candle must have the narrowest range of this many candles (itself included). */
  readonly narrowRange: { readonly lookback: number };
  readonly star: {
    /** The first and the last candle of a star have a body of at least this many ATR. */
    readonly largeBodyAtr: number;
    /** The middle candle has a body of at most this many ATR. */
    readonly smallBodyAtr: number;
  };
}

export const CANDLE_DEFAULTS: CandleParams = {
  pinBar: { wickToBody: 2, wickShare: 0.6, closeZone: 0.35 },
  engulfing: { minRangeAtr: 1 },
  narrowRange: { lookback: 7 },
  star: { largeBodyAtr: 0.6, smallBodyAtr: 0.25 },
};

/** A candlestick pattern that ends with the candle at `index`. */
export interface CandlePattern {
  /** Stable id: timeframe tag, pattern code, direction (where it has one) and the index of the last candle. */
  readonly id: string;
  readonly name: CandlePatternName;
  /** `UP` is bullish and `DOWN` bearish; the inside bar and the NR7 have no direction. */
  readonly direction: Direction | null;
  /** Position of the last candle of the pattern in the series fed so far (0 is the first candle). */
  readonly index: number;
  readonly openTime: number;
  /** How many candles make the pattern (1 to 3). */
  readonly candles: number;
  /** The highest high and the lowest low of those candles: the stop reference of a trade taken on the pattern. */
  readonly high: number;
  readonly low: number;
  /** Range of the last candle in ATR; null while the ATR warms up. */
  readonly rangeAtr: number | null;
}
