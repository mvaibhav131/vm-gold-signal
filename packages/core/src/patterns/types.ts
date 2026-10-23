import type { Direction, Pivot, PivotKind, StructureCandle } from '../structure/types';

export type PatternName =
  | 'DOUBLE_TOP'
  | 'DOUBLE_BOTTOM'
  | 'HEAD_AND_SHOULDERS'
  | 'INVERSE_HEAD_AND_SHOULDERS'
  | 'ASCENDING_TRIANGLE'
  | 'DESCENDING_TRIANGLE'
  | 'SYMMETRICAL_TRIANGLE'
  | 'BULL_FLAG'
  | 'BEAR_FLAG'
  | 'BULL_PENNANT'
  | 'BEAR_PENNANT'
  | 'RISING_WEDGE'
  | 'FALLING_WEDGE'
  | 'RECTANGLE';

/** A line in time: its price at the anchor instant and its slope per candle of the timeframe it was drawn on. */
export interface Boundary {
  readonly openTime: number;
  readonly price: number;
  readonly slope: number;
  readonly candleMs: number;
}

/** A point of the outline of a pattern, for drawing and for the explanation. */
export interface PatternPoint {
  readonly label: string;
  readonly kind: PivotKind | 'CANDLE';
  readonly index: number;
  readonly openTime: number;
  readonly price: number;
}

export interface Pattern {
  /** For example `5mDT:12:30`: timeframe tag, pattern code and the series positions of its defining points. */
  readonly id: string;
  readonly name: PatternName;
  /** The resistance side: a close above it breaks the pattern upward. Null when an upward break is not what the pattern is about. */
  readonly up: Boundary | null;
  /** The support side: a close below it breaks the pattern downward. */
  readonly down: Boundary | null;
  /** The size of the measured move, in price. */
  readonly height: number;
  /** The outline in time order. */
  readonly points: readonly PatternPoint[];
  /** The ATR when the pattern was found: the tolerances of the pattern use it. */
  readonly atr: number;
  readonly firstIndex: number;
  readonly lastIndex: number;
  readonly formedIndex: number;
  readonly formedOpenTime: number;
  /** A break must come before this instant (where converging lines meet), or null. */
  readonly apexOpenTime: number | null;
  /** A close above (below) this price ends a reversal pattern for good. */
  readonly invalidAbove: number | null;
  readonly invalidBelow: number | null;
  /** Computed and logged, not used in decisions (wedges). */
  readonly research: boolean;
}

/** Thresholds of `strategy-config v0.1.0` (docs/02 section 4.1); hypotheses, tuned only on training data. */
export interface PatternParams {
  /** All defining points of a pattern lie within the last this many candles. */
  readonly window: number;
  readonly doubleTop: {
    readonly equalAtr: number;
    readonly minSpan: number;
    readonly maxSpan: number;
    readonly minDepthAtr: number;
    /** A close beyond the tops by more than this many ATRs ends the pattern. */
    readonly invalidAtr: number;
  };
  readonly headShoulders: {
    readonly headAtr: number;
    readonly shoulderAtr: number;
    readonly maxNecklineSlopeAtr: number;
    readonly minHeightAtr: number;
    /** Consecutive points (left shoulder to head, head to right shoulder) are this many candles apart at least and at most. */
    readonly minSpan: number;
    readonly maxSpan: number;
  };
  readonly trigger: { readonly closeAtr: number };
  readonly triangle: {
    readonly horizontalAtr: number;
    readonly minTouches: number;
    readonly compression: number;
    /** A horizontal boundary is intact while no close went beyond it by more than this many ATRs. */
    readonly boundaryCloseAtr: number;
  };
  readonly rectangle: {
    readonly touchAtr: number;
    readonly minTouches: number;
    readonly minHeightAtr: number;
    readonly maxHeightAtr: number;
    readonly minLength: number;
  };
  readonly flag: {
    readonly poleAtr: number;
    readonly poleWithin: number;
    readonly minLength: number;
    readonly maxLength: number;
    readonly maxRetrace: number;
    /** Slopes (per candle) that differ by at most this many ATRs count as parallel. */
    readonly parallelAtr: number;
    readonly compression: number;
    readonly minSpan: number;
  };
  readonly wedge: {
    readonly minSlopeAtr: number;
    readonly compression: number;
    readonly minSpan: number;
  };
  /** The rules for a boundary line fitted through swing points (flags, pennants, wedges). */
  readonly boundary: {
    readonly invalidCloseAtr: number;
    readonly betweenAtr: number;
    readonly touchAtr: number;
  };
}

export const PATTERN_DEFAULTS: PatternParams = {
  window: 120,
  doubleTop: { equalAtr: 0.25, minSpan: 8, maxSpan: 60, minDepthAtr: 1, invalidAtr: 0.25 },
  headShoulders: {
    headAtr: 0.5,
    shoulderAtr: 0.5,
    maxNecklineSlopeAtr: 0.1,
    minHeightAtr: 1,
    minSpan: 8,
    maxSpan: 60,
  },
  trigger: { closeAtr: 0.1 },
  triangle: { horizontalAtr: 0.2, minTouches: 2, compression: 0.6, boundaryCloseAtr: 0.1 },
  rectangle: { touchAtr: 0.2, minTouches: 2, minHeightAtr: 1.5, maxHeightAtr: 4, minLength: 12 },
  flag: {
    poleAtr: 3,
    poleWithin: 8,
    minLength: 5,
    maxLength: 20,
    maxRetrace: 0.5,
    parallelAtr: 0.05,
    compression: 0.6,
    minSpan: 3,
  },
  wedge: { minSlopeAtr: 0.02, compression: 0.6, minSpan: 6 },
  boundary: { invalidCloseAtr: 0.1, betweenAtr: 0.15, touchAtr: 0.15 },
};

/** What the detectors read: the recent candles, the confirmed swing points and the ATR of one timeframe. */
export interface PatternInput {
  /** The most recent candles of the series, oldest first, in order. At least the last `window` if they exist. */
  readonly candles: readonly StructureCandle[];
  /** How many candles the series has had in all: `candles[i]` is candle number `count - candles.length + i`. */
  readonly count: number;
  readonly highs: readonly Pivot[];
  readonly lows: readonly Pivot[];
  /** ATR of the same timeframe as of now; null while it warms up (nothing is found). */
  readonly atr: number | null;
  readonly candleMs: number;
  readonly tag?: string;
  readonly params?: PatternParams;
}

/** A break of a pattern. */
export interface PatternBreakout {
  readonly pattern: Pattern;
  readonly direction: Direction;
  readonly index: number;
  readonly openTime: number;
  readonly close: number;
  /** The price of the broken boundary at the candle. */
  readonly level: number;
  readonly beyondAtr: number;
  /** The measured move from the broken level: `level` plus or minus the pattern height. */
  readonly target: number;
}
