import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import type { StrategySetup } from '../types';

/**
 * Numbers of strategy C, Squeeze Breakout and Retest (docs/02 section 7.C and 7.3). Six are the
 * `squeeze_retest` params of `strategy-config v0.1.0` (`squeezeMinCandles15m`, `donchianPeriod`,
 * `breakoutMinAtr`, `retestWithinCandles`, `retestMaxDistanceAtr`, `stopBufferAtr`); the periods,
 * the release window and the rejection wick are decisions of section 7.3. They are hypotheses,
 * tuned only on training data.
 */
export interface SqueezeRetestParams {
  readonly atrPeriod: number;
  readonly adxPeriod: number;
  /** The 15m squeeze was on for at least this many candles before it was released. */
  readonly squeezeMinCandles15m: number;
  /** The release is among this many of the newest 15m candles (the release candle counts). */
  readonly releaseWithinCandles15m: number;
  /** The breakout is a 5m close beyond the highest high of this many candles before it. */
  readonly donchianPeriod: number;
  /** ... by at least this many ATR(5m). */
  readonly breakoutMinAtr: number;
  /** The retest comes on one of this many candles after the breakout candle. */
  readonly retestWithinCandles: number;
  /** The retest candle reaches to within this many ATR(5m) of the broken level. */
  readonly retestMaxDistanceAtr: number;
  /** The wick of the retest candle on the side of the level is at least this share of its range. */
  readonly rejectionWickRatio: number;
  /** The stop is this many ATR(5m) beyond the retest low. */
  readonly stopBufferAtr: number;
}

export const SQUEEZE_RETEST_DEFAULTS: SqueezeRetestParams = {
  atrPeriod: INDICATOR_DEFAULTS.atrPeriod,
  adxPeriod: INDICATOR_DEFAULTS.adxPeriod,
  squeezeMinCandles15m: 8,
  releaseWithinCandles15m: 6,
  donchianPeriod: INDICATOR_DEFAULTS.donchianPeriods[0],
  breakoutMinAtr: 0.1,
  retestWithinCandles: 8,
  retestMaxDistanceAtr: 0.25,
  rejectionWickRatio: 0.3,
  stopBufferAtr: 0.2,
};

/** The rules of the strategy, in the order of docs/02 section 7.C. Every one must hold. */
export const SQUEEZE_CHECKS = [
  'squeezeReleased',
  'breakout',
  'retestTouched',
  'closeAboveLevel',
  'rejectionWick',
] as const;

export type SqueezeCheck = (typeof SQUEEZE_CHECKS)[number];
export type SqueezeChecks = Readonly<Record<SqueezeCheck, boolean>>;

/** What the 15m squeeze has been doing. `null` is a value that does not exist yet (warm-up). */
export interface SqueezeContext {
  /** The Bollinger bands are inside the Keltner channel now. */
  readonly on: boolean | null;
  /** How many 15m candles the squeeze that the newest release ended had been on; null if none was released. */
  readonly releasedRun: number | null;
  /** 15m candles since the newest release (0 is the release candle); null if none was released. */
  readonly barsSinceRelease: number | null;
}

/** A 5m candle as the rules need it. */
export interface Candle {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** A breakout that is waiting for its retest, as for a BUY (the SELL side is fed mirrored prices). */
export interface BreakoutCandidate {
  /** The broken level: the highest high of the candles before the breakout candle. */
  readonly level: number;
  readonly openTime: number;
  /** 5m candles from the breakout candle to the newest one: 1 is the candle right after it. */
  readonly candlesSince: number;
  /** The lowest low from the candle after the breakout to the newest candle, which is included. */
  readonly lowest: number;
  /** How far the breakout candle closed beyond the level, in ATRs. */
  readonly closeAtr: number;
  readonly displacementAtr: number;
  /** ADX(5m) on the breakout candle and on the candle before it. */
  readonly adx: number;
  readonly adxBefore: number;
}

/** The numbers the rules look at, as for a BUY. */
export interface SqueezeInputs {
  readonly context: SqueezeContext;
  /** The breakout that the newest candle is judged against (see `chooseBreakout`), or null. */
  readonly breakout: BreakoutCandidate | null;
  readonly candle: Candle;
  /** ATR(5m) including the newest candle. */
  readonly atr: number | null;
}

/** The numbers behind a Squeeze Retest setup, in real prices. */
export interface SqueezeFacts {
  /** The broken level and the breakout candle. */
  readonly level: number;
  readonly breakoutOpenTime: number;
  readonly candlesSinceBreakout: number;
  readonly breakoutCloseAtr: number;
  readonly breakoutDisplacementAtr: number;
  readonly adx: number;
  readonly adxBefore: number;
  /** The extreme of the retest, from the candle after the breakout to the trigger candle: the lowest low of a BUY, the highest high of a SELL. */
  readonly retestExtreme: number;
  /** How far the retest extreme stayed from the level, in ATRs: positive when it did not reach it. */
  readonly retestDistanceAtr: number;
  readonly wickRatio: number;
  readonly squeezeCandles15m: number;
  readonly candlesSinceRelease15m: number;
  readonly atr: number;
}

export type SqueezeSetup = StrategySetup<SqueezeFacts>;

export interface SqueezeSideEvaluation {
  readonly checks: SqueezeChecks;
  /** Set when every check holds and the stop could be placed. */
  readonly setup: SqueezeSetup | null;
}

export interface SqueezeEvaluation {
  /** Open time and close of the newest 5m candle, the one this answer is for. */
  readonly openTime: number;
  readonly close: number;
  readonly BUY: SqueezeSideEvaluation;
  readonly SELL: SqueezeSideEvaluation;
  /** The setup of whichever side has one. Both cannot: a close above the level cannot also be a close below it. */
  readonly setup: SqueezeSetup | null;
}
