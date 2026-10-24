import type { NewsState, Session, Side } from '../domain';
import { band, meanOf, ramp } from './ramps';

export type ChartState = 'UP' | 'DOWN' | 'RANGE';

/** The 1h trend. EMAs are the 1h EMA 20, 50 and 200; ADX, DI and the Supertrend are the 1h ones. `null` is data that is not available. */
export interface QualityTrendFacts {
  readonly ema20: number | null;
  readonly ema50: number | null;
  readonly ema200: number | null;
  /** The change of the 1h EMA 50 over the last 3 hours in ATR(1h), signed as the real chart. */
  readonly ema50SlopeAtr: number | null;
  readonly adx: number | null;
  readonly plusDI: number | null;
  readonly minusDI: number | null;
  readonly supertrend: 'UP' | 'DOWN' | null;
}

export interface QualityStructureFacts {
  readonly state15m: ChartState | null;
  readonly state5m: ChartState | null;
  /** The newest BOS or CHoCH of the 5m structure: in the direction of the trade, none, or against it. */
  readonly breakEvent: 'WITH' | 'NONE' | 'AGAINST' | null;
  /** Strategy B only: the sweep that the setup rests on. Null for every other strategy. */
  readonly sweep: { readonly depthAtr: number; readonly wickRatio: number } | null;
  /** How many trendlines and zones agree with the trade (0 to 3 or more). */
  readonly confluence: number | null;
  /** Strategy E only: the measured move in R. Null for every other strategy. */
  readonly patternMoveR: number | null;
}

export interface QualityTriggerFacts {
  /** The range of the trigger candle in ATR(5m). */
  readonly rangeAtr: number | null;
  /** Where the trigger candle closed in its range, 0 at the low and 1 at the high, as the real chart. */
  readonly closeLocation: number | null;
  /** RSI(5m) now and at its extreme during the pullback (the low of a BUY, the high of a SELL). */
  readonly rsiNow: number | null;
  readonly rsiExtreme: number | null;
  /** Candles in a row that the MACD histogram has risen (positive) or fallen (negative). */
  readonly macdBars: number | null;
}

export interface QualityVolatilityFacts {
  /** Percentile of ATR(5m) against the last 480 candles of 15m, 0 to 100. */
  readonly atrPercentile: number | null;
  readonly squeeze: 'RELEASED' | 'NONE' | 'ON' | null;
}

export interface QualityExecutionFacts {
  /** The spread as a percentile of the recent spreads, 0 to 100. */
  readonly spreadPercentile: number | null;
  /** The stop distance in ATR(5m). */
  readonly stopAtr: number | null;
}

export interface QualitySessionMacroFacts {
  readonly session: Session | null;
  readonly news: { readonly state: NewsState; readonly minutesToNext: number | null } | null;
}

export interface QualityRewardFacts {
  /** The distance to TP1 in ATR(5m). */
  readonly tp1Atr: number | null;
  /** The distance to the nearest major opposing level as a multiple of the distance to TP1; `NONE` when no level is ahead. */
  readonly levelRoom: number | 'NONE' | null;
}

export interface QualityInputs {
  readonly trend: QualityTrendFacts;
  readonly structure: QualityStructureFacts;
  readonly trigger: QualityTriggerFacts;
  readonly volatility: QualityVolatilityFacts;
  readonly execution: QualityExecutionFacts;
  readonly sessionMacro: QualitySessionMacroFacts;
  readonly reward: QualityRewardFacts;
}

const sign = (side: Side): 1 | -1 => (side === 'BUY' ? 1 : -1);
const ahead = (side: Side): ChartState => (side === 'BUY' ? 'UP' : 'DOWN');

/** 1 when the chart goes the way of the trade, 0.5 in a range, 0 against it. */
function alignment(state: ChartState | null, side: Side): number | null {
  if (state === null) return null;
  if (state === ahead(side)) return 1;
  return state === 'RANGE' ? 0.5 : 0;
}

/**
 * Trend (docs/02 section 8.1): the mean of the EMA order (each of the two pairs 20/50 and 50/200 in
 * the order of the trade counts half), the slope of the EMA 50 (0 when flat, 1 from 0.5 ATR(1h) in
 * 3 hours), ADX(1h) (0 at 15, 1 at 35, and 0 when the DI points the other way) and the Supertrend
 * (1 with the trade, 0 against it).
 */
export function trendStrength(side: Side, facts: QualityTrendFacts): number | null {
  const s = sign(side);
  const { ema20, ema50, ema200 } = facts;
  const order =
    ema20 === null || ema50 === null || ema200 === null
      ? null
      : (s * (ema20 - ema50) > 0 ? 0.5 : 0) + (s * (ema50 - ema200) > 0 ? 0.5 : 0);
  const slope = facts.ema50SlopeAtr === null ? null : ramp(s * facts.ema50SlopeAtr, 0, 0.5);
  const against =
    facts.plusDI !== null && facts.minusDI !== null && s * (facts.plusDI - facts.minusDI) < 0;
  const adx = facts.adx === null ? null : against ? 0 : ramp(facts.adx, 15, 35);
  const supertrend = facts.supertrend === null ? null : facts.supertrend === ahead(side) ? 1 : 0;
  return meanOf([order, slope, adx, supertrend]);
}

/**
 * Structure: the mean of the alignment of the 15m and 5m state (1 with the trade, 0.5 range, 0
 * against; the mean of those that exist), the newest BOS or CHoCH (1 with, 0.5 none, 0 against), the
 * sweep (depth 0.1 to 0.6 ATR and wick 50 to 80 percent), the confluence (0 at none, 1 at two) and
 * the measured move of a pattern (0 at 1.5 R, 1 at 3 R).
 */
export function structureStrength(side: Side, facts: QualityStructureFacts): number | null {
  const states = meanOf([alignment(facts.state15m, side), alignment(facts.state5m, side)]);
  const event =
    facts.breakEvent === null ? null : { WITH: 1, NONE: 0.5, AGAINST: 0 }[facts.breakEvent];
  const sweep =
    facts.sweep === null
      ? null
      : (ramp(facts.sweep.depthAtr, 0.1, 0.6) + ramp(facts.sweep.wickRatio, 0.5, 0.8)) / 2;
  const confluence = facts.confluence === null ? null : ramp(facts.confluence, 0, 2);
  const pattern = facts.patternMoveR === null ? null : ramp(facts.patternMoveR, 1.5, 3);
  return meanOf([states, event, sweep, confluence, pattern]);
}

/**
 * Trigger and momentum: the mean of the size of the trigger candle (0 at 0.6 ATR, 1 at 1.6), where it
 * closed (0 at the middle, 1 at 90 percent of its range towards the trade), the RSI reset (the move
 * of the RSI away from its extreme: 0 at 5 points, 1 at 20) and the MACD histogram (0 at none, 1 at
 * 3 candles in a row in the direction of the trade).
 */
export function triggerStrength(side: Side, facts: QualityTriggerFacts): number | null {
  const s = sign(side);
  const size = facts.rangeAtr === null ? null : ramp(facts.rangeAtr, 0.6, 1.6);
  const close =
    facts.closeLocation === null
      ? null
      : ramp(side === 'BUY' ? facts.closeLocation : 1 - facts.closeLocation, 0.5, 0.9);
  const reset =
    facts.rsiNow === null || facts.rsiExtreme === null
      ? null
      : ramp(s * (facts.rsiNow - facts.rsiExtreme), 5, 20);
  const macd = facts.macdBars === null ? null : ramp(s * facts.macdBars, 0, 3);
  return meanOf([size, close, reset, macd]);
}

/**
 * Volatility: the mean of the ATR percentile (best from 30 to 70, nothing at 10 or 90) and the squeeze
 * (1 just released, 0.7 none, 0.3 still on).
 */
export function volatilityStrength(facts: QualityVolatilityFacts): number | null {
  const percentile =
    facts.atrPercentile === null ? null : band(facts.atrPercentile, [10, 30, 70, 90]);
  const squeeze =
    facts.squeeze === null ? null : { RELEASED: 1, NONE: 0.7, ON: 0.3 }[facts.squeeze];
  return meanOf([percentile, squeeze]);
}

/**
 * Execution: the mean of the spread percentile (1 up to the 40th, 0 from the 95th) and the stop size
 * (best from 1.1 to 1.7 ATR, nothing at the 0.8 and 2.0 ATR limits of STOP_OK).
 */
export function executionStrength(facts: QualityExecutionFacts): number | null {
  const spread = facts.spreadPercentile === null ? null : ramp(facts.spreadPercentile, 95, 40);
  const stop = facts.stopAtr === null ? null : band(facts.stopAtr, [0.8, 1.1, 1.7, 2.0]);
  return meanOf([spread, stop]);
}

/** How well a session suits the trade: the hours of London and New York trade best. */
export const SESSION_SUITABILITY: Readonly<Record<Session, number>> = {
  LONDON: 1,
  OVERLAP: 1,
  NEW_YORK: 0.9,
  ASIA: 0.5,
  ROLLOVER: 0.2,
};

/**
 * Session and macro: the mean of the session and the news. News is 0 inside the window of a
 * high-impact event, unknown when the calendar is unavailable, and otherwise 1 with no event known
 * or from 4 hours away down to 0 at 45 minutes.
 */
export function sessionMacroStrength(facts: QualitySessionMacroFacts): number | null {
  const session = facts.session === null ? null : SESSION_SUITABILITY[facts.session];
  let news: number | null = null;
  if (facts.news !== null && facts.news.state !== 'UNKNOWN') {
    news =
      facts.news.state === 'IN_WINDOW'
        ? 0
        : facts.news.minutesToNext === null
          ? 1
          : ramp(facts.news.minutesToNext, 45, 240);
  }
  return meanOf([session, news]);
}

/**
 * Reward feasibility: the mean of the distance to TP1 (1 up to 1.5 ATR, 0 at the 2.5 ATR limit of
 * TARGET_OK) and the room to the nearest opposing level (0 when it is half way to TP1, 1 from 1.2
 * times the distance to TP1, 1 when none is ahead).
 */
export function rewardStrength(facts: QualityRewardFacts): number | null {
  const tp1 = facts.tp1Atr === null ? null : ramp(facts.tp1Atr, 2.5, 1.5);
  const room =
    facts.levelRoom === null
      ? null
      : facts.levelRoom === 'NONE'
        ? 1
        : ramp(facts.levelRoom, 0.5, 1.2);
  return meanOf([tp1, room]);
}
