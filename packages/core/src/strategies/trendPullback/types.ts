import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import type { StructureState } from '../../structure/types';
import type { StrategySetup } from '../types';

/**
 * Numbers of strategy A, Trend Pullback (docs/02 section 7.A and 7.1). The first six are the
 * `trend_pullback` params of `strategy-config v0.1.0`; `legLookbackCandles` and the periods are
 * decisions of section 7.1. They are hypotheses, tuned only on training data.
 */
export interface TrendPullbackParams {
  readonly periods: {
    /** 1h and 5m moving averages. The 1h trend needs all three, the 5m value zone the first two. */
    readonly emaFast: number;
    readonly emaMid: number;
    readonly emaSlow: number;
    readonly rsi: number;
    readonly atr: number;
  };
  /** The 1h EMA(mid) must be higher than it was this many 1h candles ago. */
  readonly emaSlopeHours: number;
  /** RSI(5m) was at or below this within the last `rsiLookbackCandles` candles. */
  readonly rsiPullbackMax: number;
  readonly rsiLookbackCandles: number;
  /** RSI(5m) is now above its value this many candles ago. */
  readonly rsiRiseLookbackCandles: number;
  /** The MACD histogram rose on each of this many candles in a row. */
  readonly macdRisingCandles: number;
  /** The stop is this many ATR(5m) beyond the pullback extreme. */
  readonly stopBufferAtr: number;
  /** The pullback began at the highest high of this many 5m candles before the trigger candle. */
  readonly legLookbackCandles: number;
}

export const TREND_PULLBACK_DEFAULTS: TrendPullbackParams = {
  periods: {
    emaFast: INDICATOR_DEFAULTS.emaPeriods[1],
    emaMid: INDICATOR_DEFAULTS.emaPeriods[2],
    emaSlow: INDICATOR_DEFAULTS.emaPeriods[3],
    rsi: INDICATOR_DEFAULTS.rsiPeriod,
    atr: INDICATOR_DEFAULTS.atrPeriod,
  },
  emaSlopeHours: 6,
  rsiPullbackMax: 45,
  rsiLookbackCandles: 12,
  rsiRiseLookbackCandles: 3,
  macdRisingCandles: 2,
  stopBufferAtr: 0.25,
  legLookbackCandles: 36,
};

/** The rules of the strategy, in the order of docs/02 section 7.A. Every one must hold. */
export const PULLBACK_CHECKS = [
  'trend1h',
  'slope1h',
  'structure15m',
  'lowIntact15m',
  'pulledBack',
  'rsiReset',
  'rsiTurning',
  'closeAboveEma',
  'closeAbovePreviousHigh',
  'breakOrDisplacement',
  'macdRising',
] as const;

export type PullbackCheck = (typeof PULLBACK_CHECKS)[number];
export type PullbackChecks = Readonly<Record<PullbackCheck, boolean>>;

/**
 * The numbers the rules look at, as for a BUY (the SELL side is fed mirrored prices, so nothing
 * here has a direction). `null` is a value that does not exist yet, and a rule that needs it fails.
 */
export interface PullbackInputs {
  /** 1h moving averages of the close. */
  readonly ema1h: {
    readonly fast: number | null;
    readonly mid: number | null;
    readonly slow: number | null;
  };
  /** 1h EMA(mid) now minus its value `emaSlopeHours` candles ago. */
  readonly midSlope1h: number | null;
  readonly state15m: StructureState | null;
  /** No 15m candle has closed below the last confirmed 15m swing low; null if there is no such low. */
  readonly lowIntact15m: boolean | null;
  /** The upper edge of the 38.2 to 61.8 percent retracement of the last 15m impulse leg. */
  readonly fibTop: number | null;

  /** The newest 5m candle (the trigger candle). */
  readonly close: number;
  readonly previousHigh: number | null;
  /** The 5m EMA that the close must be above. */
  readonly emaFast5m: number | null;
  /**
   * Some candle from the start of the pullback up to the newest had its low at or below the upper
   * edge of the band between the 5m EMAs, as of that candle (the EMAs of today are averages of
   * the pullback itself and would always be reached).
   */
  readonly emaTouched: boolean;
  readonly rsi: {
    readonly now: number | null;
    /** The lowest RSI of the last `rsiLookbackCandles` candles, the newest included. */
    readonly lowest: number | null;
    /** RSI `rsiRiseLookbackCandles` candles ago. */
    readonly before: number | null;
  };
  /** The MACD histogram of the newest `macdRisingCandles + 1` candles, oldest first; null before it exists. */
  readonly histogram: readonly number[] | null;
  /** The lowest low from the start of the pullback up to and including the trigger candle. */
  readonly legLow: number | null;
  /** The last 5m swing high formed since the pullback began. */
  readonly breakLevel: number | null;
  /** The trigger candle is a bullish displacement candle. */
  readonly displacement: boolean;
}

/** Where the price went back to: the band between the 5m EMAs, the Fibonacci zone of the 15m leg, or both. */
export type PullbackZone = 'EMA' | 'FIB' | 'EMA+FIB';

/** The numbers behind a Trend Pullback setup, in real prices. */
export interface PullbackFacts {
  /** The candle where the pullback began and its extreme (the high of a BUY, the low of a SELL). */
  readonly legStart: { readonly openTime: number; readonly price: number };
  /** The pullback extreme since then: the lowest low of a BUY, the highest high of a SELL. */
  readonly legExtreme: number;
  readonly zone: PullbackZone;
  readonly atr: number;
  /** The RSI(5m) now, and its extreme of the lookback (lowest for a BUY, highest for a SELL). */
  readonly rsi: number;
  readonly rsiExtreme: number;
  /** The last 5m swing level since the pullback began (null if none had formed) and whether the close is beyond it. */
  readonly breakLevel: number | null;
  readonly brokeLevel: boolean;
  readonly displacement: boolean;
}

export type PullbackSetup = StrategySetup<PullbackFacts>;

export interface PullbackSideEvaluation {
  readonly checks: PullbackChecks;
  /** Set when every check holds and the stop could be placed. */
  readonly setup: PullbackSetup | null;
}

export interface PullbackEvaluation {
  /** Open time and close of the newest 5m candle, the one this answer is for. */
  readonly openTime: number;
  readonly close: number;
  readonly BUY: PullbackSideEvaluation;
  readonly SELL: PullbackSideEvaluation;
  /** The setup of whichever side has one. Both cannot: the 1h trend is up or down, never both. */
  readonly setup: PullbackSetup | null;
}
