import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import type { StructureCandle } from '../../structure/types';
import type { Trendline } from '../../trendlines/lines';
import type { StrategySetup } from '../types';

/**
 * Numbers of strategy D, Trendline Break and Retest (docs/02 section 7.D and 7.4). Nine are the
 * `trendline_retest` params of `strategy-config v0.1.0`; the indicator periods are decisions of
 * section 7.4. They are hypotheses, tuned only on training data. The line finder itself (window,
 * slope, touches, validity) is section 4.1 with `TRENDLINE_DEFAULTS`, except for the numbers this
 * strategy owns (`minTouches`, the break and the retest zone), which it hands to it.
 */
export interface TrendlineRetestParams {
  readonly atrPeriod: number;
  readonly rsiPeriod: number;
  readonly adxPeriod: number;
  /** The 15m line has at least this many touches. */
  readonly minTouches: number;
  /** The 1h trend is "strongly against" the break from this ADX(1h) on, if its DI points the other way. */
  readonly maxAdx1hAgainst: number;
  /** The break is a 5m close beyond the line by at least this many ATR(5m) ... */
  readonly breakMinAtr: number;
  /** ... with a body of at least this share of the candle's range. */
  readonly breakMinBodyFraction: number;
  /** The retest comes on one of this many candles after the break candle. */
  readonly retestWithinCandles: number;
  /** The retest candle returns to within this many ATR(5m) of the line, and closes at least that far away from it. */
  readonly retestMaxDistanceAtr: number;
  /** The wick of the retest candle on the side of the line is at least this share of its range. */
  readonly retestMinWickFraction: number;
  /** RSI(5m) on the retest candle is above this value. */
  readonly retestMinRsi: number;
  /** The stop is this many ATR(5m) beyond the retest low (or the line). */
  readonly stopBufferAtr: number;
}

export const TRENDLINE_RETEST_DEFAULTS: TrendlineRetestParams = {
  atrPeriod: INDICATOR_DEFAULTS.atrPeriod,
  rsiPeriod: INDICATOR_DEFAULTS.rsiPeriod,
  adxPeriod: INDICATOR_DEFAULTS.adxPeriod,
  minTouches: 3,
  maxAdx1hAgainst: 30,
  breakMinAtr: 0.1,
  breakMinBodyFraction: 0.5,
  retestWithinCandles: 8,
  retestMaxDistanceAtr: 0.3,
  retestMinWickFraction: 0.3,
  retestMinRsi: 45,
  stopBufferAtr: 0.25,
};

/** The rules of the strategy, in the order of docs/02 section 7.D. Every one must hold. */
export const TRENDLINE_CHECKS = [
  'trend1h',
  'lineBroken',
  'returned',
  'closedAway',
  'rejectionWick',
  'rsiAbove',
] as const;

export type TrendlineCheck = (typeof TRENDLINE_CHECKS)[number];
export type TrendlineChecks = Readonly<Record<TrendlineCheck, boolean>>;

/** The 1h trend as ADX(1h) with its two directional indicators, as for a BUY. `null` is a value that does not exist yet (warm-up). */
export interface HourTrend {
  readonly adx: number;
  readonly plusDI: number;
  readonly minusDI: number;
}

/** A break that is waiting for its retest, as for a BUY (the SELL side is fed mirrored prices). */
export interface BreakCandidate {
  /** The broken line, a falling resistance line of the 15m chart. */
  readonly line: Trendline;
  readonly breakOpenTime: number;
  /** 5m candles from the break candle to the newest one: 1 is the candle right after it. */
  readonly candlesSince: number;
  /** The lowest low from the candle after the break to the newest candle, which is included. */
  readonly lowest: number;
  /** Some candle from the one after the break to the newest came back to within the zone of the line. */
  readonly returned: boolean;
  /** How far the break candle closed beyond the line, in ATRs, and its body over range. */
  readonly beyondAtr: number;
  readonly bodyRatio: number;
}

/** The numbers the rules look at, as for a BUY. */
export interface TrendlineInputs {
  readonly trend: HourTrend | null;
  /** The break that the newest candle is judged against (see `chooseBreak`), or null. */
  readonly candidate: BreakCandidate | null;
  readonly candle: StructureCandle;
  /** ATR(5m) and RSI(5m) including the newest candle. */
  readonly atr: number | null;
  readonly rsi: number | null;
}

/** The numbers behind a Trendline Retest setup, in real prices. */
export interface TrendlineRetestFacts {
  /** The two swing points the 15m line passes through (open times of the 15m candles) and its touches. */
  readonly lineFrom: number;
  readonly lineTo: number;
  readonly touches: number;
  /** The price of the line at the retest candle. */
  readonly lineValue: number;
  /** Price change of the line per 15m candle: negative for the resistance line of a BUY, positive for a SELL. */
  readonly lineSlope: number;
  readonly breakOpenTime: number;
  readonly candlesSinceBreak: number;
  readonly breakBeyondAtr: number;
  readonly breakBodyRatio: number;
  /** The extreme of the retest, from the candle after the break to the retest candle: the lowest low of a BUY, the highest high of a SELL. */
  readonly retestExtreme: number;
  /** How far the retest extreme stayed from the line, in ATRs: positive when it did not reach it. */
  readonly retestDistanceAtr: number;
  /** How far the retest candle closed from the line, in ATRs. */
  readonly closeAwayAtr: number;
  readonly wickRatio: number;
  readonly rsi: number;
  readonly adx1h: number;
  /** The 1h directional indicator points the way of the break (or is level). */
  readonly adx1hAligned: boolean;
  /** The stop sits beyond the line, because that is closer than the retest extreme. */
  readonly stopFromLine: boolean;
  readonly atr: number;
}

export type TrendlineRetestSetup = StrategySetup<TrendlineRetestFacts>;

export interface TrendlineSideEvaluation {
  readonly checks: TrendlineChecks;
  /** Set when every check holds and the stop could be placed. */
  readonly setup: TrendlineRetestSetup | null;
}

export interface TrendlineEvaluation {
  /** Open time and close of the newest 5m candle, the one this answer is for. */
  readonly openTime: number;
  readonly close: number;
  readonly BUY: TrendlineSideEvaluation;
  readonly SELL: TrendlineSideEvaluation;
  /** The setup of whichever side has one (BUY if both do, which would need two lines that have crossed). */
  readonly setup: TrendlineRetestSetup | null;
}
