/** Thresholds of `strategy-config v0.1.0` (docs/02 section 4.1); hypotheses, tuned only on training data. */
export interface TrendlineParams {
  /** Swing points of the last this many candles are looked at. */
  readonly window: number;
  /** The two points of a line are at least this many candles apart. */
  readonly minSpan: number;
  /** A line rises (support) or falls (resistance) by at most this many ATRs per candle. */
  readonly maxSlopeAtr: number;
  /** A close beyond the line by more than this many ATRs, after its first point, makes it invalid. */
  readonly invalidCloseAtr: number;
  /** A swing point between the two points beyond the line by more than this many ATRs makes it invalid. */
  readonly betweenAtr: number;
  /** Swing points within this many ATRs of the line are touches. */
  readonly touchAtr: number;
  readonly minTouches: number;
  /** From this many touches on, the line is confirmed. */
  readonly confirmedTouches: number;
  /** Score: `touchWeight` per touch plus `min(length / lengthPerPoint, lengthCap)` plus recency (0 to 1). */
  readonly touchWeight: number;
  readonly lengthPerPoint: number;
  readonly lengthCap: number;
  /** A channel needs at least this many touches of its parallel line. */
  readonly channelMinTouches: number;
  readonly break: {
    /** The close is beyond the line by at least this many ATRs. */
    readonly closeAtr: number;
    /** The body of the candle is at least this share of its range. */
    readonly bodyRatio: number;
  };
  readonly retest: {
    /** The candle comes back to within this many ATRs of the line, and a close beyond this distance confirms it. */
    readonly zoneAtr: number;
    /** The retest must be completed within this many candles after the break. */
    readonly within: number;
  };
}

export const TRENDLINE_DEFAULTS: TrendlineParams = {
  window: 80,
  minSpan: 6,
  maxSlopeAtr: 0.15,
  invalidCloseAtr: 0.1,
  betweenAtr: 0.15,
  touchAtr: 0.15,
  minTouches: 2,
  confirmedTouches: 3,
  touchWeight: 2,
  lengthPerPoint: 10,
  lengthCap: 3,
  channelMinTouches: 2,
  break: { closeAtr: 0.1, bodyRatio: 0.5 },
  retest: { zoneAtr: 0.3, within: 8 },
};
