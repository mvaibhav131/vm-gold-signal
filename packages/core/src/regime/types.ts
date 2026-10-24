import type { Regime, VolBucket } from '../domain';
import { INDICATOR_DEFAULTS } from '../indicators/volatility';
import type { Direction } from '../structure/types';

/**
 * Thresholds of `strategy-config v0.1.0` (docs/02 section 5 and 5.1). They are hypotheses, tuned only
 * on training data. The rows of section 5 give the numbers; the window of the ATR percentile, the
 * volatility buckets and the order in which the rules are tried are decisions of section 5.1.
 */
export interface RegimeParams {
  readonly periods: {
    /** The three moving averages of the 1h trend rule (fast above middle above slow is an up trend). */
    readonly emaFast: number;
    readonly emaMid: number;
    readonly emaSlow: number;
    readonly adx: number;
    readonly efficiency: number;
    readonly atr: number;
  };
  readonly trend: {
    /** ADX(1h) at or above this. */
    readonly adxMin: number;
    /** Efficiency ratio (1h) at or above this. */
    readonly efficiencyMin: number;
  };
  readonly range: {
    /** ADX(1h) below this. */
    readonly adxBelow: number;
    /** The 15m candles whose high-to-low width is judged, the newest included. */
    readonly lookback: number;
    /** The width may be at most this many times ATR(15m). */
    readonly maxWidthAtr: number;
  };
  readonly squeeze: {
    /** The 15m squeeze has been on for at least this many candles. */
    readonly minDuration: number;
  };
  readonly breakout: {
    /** The squeeze was released within this many of the newest 15m candles (the release candle counts). */
    readonly withinCandles: number;
  };
  readonly highVol: {
    /** ATR(15m) percentile at or above this. */
    readonly percentileFrom: number;
    /** The percentile is the rank among this many previous ATR(15m) values (480 is five trading days). */
    readonly window: number;
  };
  readonly volBucket: {
    /** LOW below this percentile of ATR(15m), HIGH from `highFrom`, NORMAL in between. */
    readonly lowBelow: number;
    readonly highFrom: number;
  };
}

export const REGIME_DEFAULTS: RegimeParams = {
  periods: {
    emaFast: 20,
    emaMid: 50,
    emaSlow: 200,
    adx: INDICATOR_DEFAULTS.adxPeriod,
    efficiency: INDICATOR_DEFAULTS.efficiencyPeriod,
    atr: INDICATOR_DEFAULTS.atrPeriod,
  },
  trend: { adxMin: 20, efficiencyMin: 0.3 },
  range: { adxBelow: 18, lookback: 24, maxWidthAtr: 3 },
  squeeze: { minDuration: 8 },
  breakout: { withinCandles: 6 },
  highVol: { percentileFrom: 90, window: 480 },
  volBucket: { lowBelow: 33, highFrom: 67 },
};

/** The regimes a rule can give, first rule that is met wins (docs/02 section 5.1). UNCERTAIN is what is left. */
export const REGIME_PRECEDENCE = [
  'BREAKOUT',
  'SQUEEZE',
  'HIGH_VOL',
  'TREND_UP',
  'TREND_DOWN',
  'RANGE',
] as const satisfies readonly Regime[];

export type RuleRegime = (typeof REGIME_PRECEDENCE)[number];

/** The numbers the rules look at: the 1h trend values and the 15m volatility and range values. */
export interface RegimeInputs {
  /** 1h moving averages of the close. */
  readonly emaFast: number;
  readonly emaMid: number;
  readonly emaSlow: number;
  readonly adx1h: number;
  readonly efficiency1h: number;

  readonly atr15m: number;
  /** Rank of ATR(15m) among the previous values, 0 to 100. */
  readonly atrPercentile15m: number;
  /** Highest high minus lowest low of the newest `range.lookback` 15m candles. */
  readonly rangeWidth15m: number;
  /** Consecutive 15m candles the squeeze has been on; 0 means it is off. */
  readonly squeezeDuration: number;
  /** 15m candles since the squeeze was released (0 is the newest candle), null if it never was. */
  readonly releasedBarsAgo: number | null;
  /** 15m candles since the newest displacement candle (0 is the newest candle), null if there was none. */
  readonly displacementBarsAgo: number | null;
  readonly displacementDirection: Direction | null;
}

export interface RegimeResult {
  readonly regime: Regime;
  /** The trend direction for TREND_UP and TREND_DOWN, the direction of the displacement for BREAKOUT, else null. */
  readonly direction: Direction | null;
  /** Every rule that is met, in order of precedence. The first is `regime`; empty means UNCERTAIN. */
  readonly matched: readonly RuleRegime[];
}

/** The regime with the volatility bucket that the statistics use, and the numbers behind both. */
export interface RegimeSnapshot extends RegimeResult {
  readonly volBucket: VolBucket;
  readonly inputs: RegimeInputs;
}
