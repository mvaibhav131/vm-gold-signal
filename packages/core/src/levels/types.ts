/** Timeframes whose swing points make support and resistance zones (docs/02 section 4.1). */
export type ZoneTimeframe = '5m' | '15m' | '1h';

export const ZONE_TIMEFRAMES: readonly ZoneTimeframe[] = ['5m', '15m', '1h'];

/** Thresholds of `strategy-config v0.1.0`; hypotheses, tuned only on training data. */
export interface LevelParams {
  /** Round numbers are the multiples of these steps (docs/02 section 3: $10, $50, $100). */
  readonly roundSteps: readonly number[];
  readonly equal: {
    /** Swing points within this many ATRs of each other are equal. */
    readonly toleranceAtr: number;
    /** Only swing points of the last this many candles are looked at. */
    readonly lookback: number;
    readonly minPoints: number;
  };
  readonly zones: {
    /** Swing points within this many ATRs (of the 15m ATR) of each other form a cluster. */
    readonly toleranceAtr: number;
    /** The zone is the cluster range padded by this many ATRs on each side. */
    readonly padAtr: number;
    /** A close beyond the zone by this many ATRs flips its role. */
    readonly flipAtr: number;
    readonly minPoints: number;
    /** Recency weight: halves every this many candles of the point's own timeframe. */
    readonly halfLife: number;
    /** How many candles of each timeframe are searched for swing points. */
    readonly windows: Readonly<Record<ZoneTimeframe, number>>;
    readonly weights: Readonly<Record<ZoneTimeframe, number>>;
  };
  readonly fibonacci: {
    /** The impulse leg must be at least this many ATRs (15m). */
    readonly minLegAtr: number;
    readonly retracements: readonly number[];
    /** The entry zone lies between these two retracement ratios. */
    readonly entry: readonly [number, number];
    /** The value zone for pullbacks lies between these two retracement ratios. */
    readonly value: readonly [number, number];
    readonly extensions: readonly number[];
  };
}

export const LEVEL_DEFAULTS: LevelParams = {
  roundSteps: [10, 50, 100],
  equal: { toleranceAtr: 0.15, lookback: 100, minPoints: 2 },
  zones: {
    toleranceAtr: 0.25,
    padAtr: 0.05,
    flipAtr: 0.2,
    minPoints: 2,
    halfLife: 100,
    windows: { '5m': 300, '15m': 200, '1h': 150 },
    weights: { '5m': 1, '15m': 2, '1h': 3 },
  },
  fibonacci: {
    minLegAtr: 2.5,
    retracements: [0.382, 0.5, 0.618, 0.786],
    entry: [0.618, 0.786],
    value: [0.382, 0.618],
    extensions: [1.272, 1.618],
  },
};
