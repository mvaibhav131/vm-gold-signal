import type { Side } from '../../domain';
import type { ConfluenceParams, ConfluenceVote } from './types';

export type Trend = 'UP' | 'DOWN' | null;

/** How many 5m candles before the trigger candle form the range that a breakout must clear. */
export const BREAKOUT_CANDLES = 6;

/** The trend of a 1h chart: UP when the fast average is above the middle one and the price above the slow one, DOWN for the mirror, else none. */
export function judgeHourTrend(
  close: number,
  emaFast: number,
  emaMid: number,
  emaSlow: number,
): Trend {
  if (emaFast > emaMid && close > emaSlow) return 'UP';
  if (emaFast < emaMid && close < emaSlow) return 'DOWN';
  return null;
}

/** The trend of a 15m chart: only the two averages (no slow one), so it turns sooner than the hour. */
export function judgeQuarterTrend(emaFast: number, emaMid: number): Trend {
  if (emaFast > emaMid) return 'UP';
  if (emaFast < emaMid) return 'DOWN';
  return null;
}

/** Everything a vote reads, from the newest closed 5m candle and the charts above it (real prices, never mirrored). */
export interface VoteInput {
  readonly trend1h: Trend;
  readonly trend15m: Trend;
  readonly close: number;
  readonly emaFast: number;
  readonly emaMid: number;
  readonly rsi: number;
  readonly macdHistogram: number;
  readonly macdChange: number | null;
  readonly adx: number;
  readonly plusDI: number;
  readonly minusDI: number;
  /** The mean of the 5m closes of the UTC day so far. */
  readonly dayMean: number;
  /** The highest high and the lowest low of the `BREAKOUT_CANDLES` candles before the newest one. */
  readonly priorHigh: number;
  readonly priorLow: number;
  readonly atr: number;
}

/** The ADX below which there is no trend to speak of. */
export const ADX_TREND = 20;
/** The RSI must be on the side of 50 of the trade, but not further than this many points from it. */
export const RSI_ROOM = 25;
/** The price must be above (BUY) the fast average, but not further than this many ATR: further is a chase. */
export const STRETCH_ATR = 1.5;

/**
 * The votes that agree with a side. SELL is the exact mirror of BUY: every comparison is made in the direction of the trade
 * (`dir` is +1 for a BUY and -1 for a SELL), so the same function reads a market and its mirror image.
 */
export function votesFor(side: Side, input: VoteInput): ConfluenceVote[] {
  const dir = side === 'BUY' ? 1 : -1;
  const trend = side === 'BUY' ? 'UP' : 'DOWN';
  const passed: ConfluenceVote[] = [];
  if (input.trend1h === trend) passed.push('TREND_1H');
  if (input.trend15m === trend) passed.push('TREND_15M');
  if (dir * (input.emaFast - input.emaMid) > 0) passed.push('EMA_STACK_5M');
  const rsiRoom = dir * (input.rsi - 50);
  if (rsiRoom > 0 && rsiRoom < RSI_ROOM) passed.push('RSI');
  if (dir * input.macdHistogram > 0 && input.macdChange !== null && dir * input.macdChange > 0) {
    passed.push('MACD');
  }
  if (input.adx >= ADX_TREND && dir * (input.plusDI - input.minusDI) > 0) passed.push('ADX');
  if (dir * (input.close - input.dayMean) > 0) passed.push('DAY_MEAN');
  if (side === 'BUY' ? input.close > input.priorHigh : input.close < input.priorLow) {
    passed.push('BREAKOUT');
  }
  const stretch = dir * (input.close - input.emaFast);
  if (stretch > 0 && stretch < STRETCH_ATR * input.atr) passed.push('NOT_STRETCHED');
  return passed;
}

/** The candle that closes the setup must push the way of the trade with a real body. */
export function triggerBody(
  side: Side,
  open: number,
  close: number,
  atr: number,
  minBodyAtr: number,
): boolean {
  const dir = side === 'BUY' ? 1 : -1;
  return dir * (close - open) >= minBodyAtr * atr;
}

export interface StopPlan {
  /** The level of the stop. */
  readonly stopLoss: number;
  /** The distance from the close to the stop in dollars. */
  readonly distance: number;
  /** The structure level it was built from. */
  readonly swingLevel: number;
}

/**
 * The stop of a setup: beyond the swing (below the lowest low of a BUY, above the highest high of a SELL) by a buffer, and at
 * least `minStopAtr` from the price. Structure that is further than `maxStopAtr` (or than `maxStopUsd` dollars) gives no setup:
 * the stop is never pulled in to a place where the structure says it would be hit. Null when it is skipped.
 */
export function stopPlan(
  side: Side,
  close: number,
  atr: number,
  swingLevel: number,
  params: Pick<ConfluenceParams, 'stopBufferAtr' | 'minStopAtr' | 'maxStopAtr' | 'maxStopUsd'>,
): StopPlan | null {
  const buffered =
    side === 'BUY'
      ? swingLevel - params.stopBufferAtr * atr
      : swingLevel + params.stopBufferAtr * atr;
  const raw = side === 'BUY' ? close - buffered : buffered - close;
  if (!(raw > 0) || raw > params.maxStopAtr * atr) return null;
  const distance = Math.max(raw, params.minStopAtr * atr);
  if (distance > params.maxStopUsd) return null;
  return {
    stopLoss: side === 'BUY' ? close - distance : close + distance,
    distance,
    swingLevel,
  };
}
