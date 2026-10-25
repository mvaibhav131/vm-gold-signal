import { assertFinite } from '../indicators/types';
import {
  COUNTERFACTUAL_CANDLE_MS,
  type AfterCandle,
  type AutopsyParams,
  type Counterfactual,
  type ReviewedTrade,
} from './types';

function reaches(side: ReviewedTrade['side'], candle: AfterCandle, target: number): boolean {
  return side === 'BUY' ? candle.high >= target : candle.low <= target;
}

/**
 * Whether price went on to the targets after the trade closed (02_Signal_Engine section 12): the
 * 12 candles of 5m that open at or after the close, counted from 1. The candle that holds the close
 * is left out, because what it did before the exit is already part of the trade; a reversal inside
 * that candle is therefore not seen (conservative, to review).
 *
 * The candles must follow each other without a hole. A target that was not reached in a window that
 * is not fully seen is not "not reached": it is not known, and then there is no counterfactual (null).
 * A target that was reached is known even if the window is not complete.
 */
export function counterfactualOf(
  trade: Pick<ReviewedTrade, 'side' | 'tp1' | 'tp2'>,
  closedAt: number,
  candles: readonly AfterCandle[],
  params: Pick<AutopsyParams, 'counterfactualCandles'>,
): Counterfactual | null {
  assertFinite(closedAt, 'closedAt');
  const window = params.counterfactualCandles;
  for (const candle of candles) {
    assertFinite(candle.openTime, 'candle time');
    assertFinite(candle.high, 'candle high');
    assertFinite(candle.low, 'candle low');
    if (!(candle.low <= candle.high)) throw new RangeError('a candle needs low <= high');
  }
  const after = candles
    .filter((candle) => candle.openTime >= closedAt)
    .sort((a, b) => a.openTime - b.openTime);

  const first = Math.ceil(closedAt / COUNTERFACTUAL_CANDLE_MS) * COUNTERFACTUAL_CANDLE_MS;
  let tp1At: number | null = null;
  let tp2At: number | null = null;
  let complete = true;
  for (let i = 0; i < window; i += 1) {
    const candle = after[i];
    if (candle?.openTime !== first + i * COUNTERFACTUAL_CANDLE_MS) {
      complete = false;
      break;
    }
    if (tp1At === null && reaches(trade.side, candle, trade.tp1)) tp1At = i + 1;
    if (tp2At === null && trade.tp2 !== null && reaches(trade.side, candle, trade.tp2)) {
      tp2At = i + 1;
    }
  }

  if (tp1At === null && !complete) return null;
  const result: Counterfactual = { reachedTp1: tp1At !== null, candlesToTp1: tp1At };
  if (trade.tp2 === null) return result;
  if (tp2At !== null) return { ...result, reachedTp2: true, candlesToTp2: tp2At };
  return complete ? { ...result, reachedTp2: false, candlesToTp2: null } : result;
}
