import { BASELINE_CANDLES_24H, MedianBaseline } from '../context/baseline';
import { ratioOf } from '../context/newsShock';
import type { Bar } from '../indicators/types';
import { Atr } from '../indicators/volatility';

/** A complete 5m candle (mid prices) with its open time: `MarketCandle` fits. */
export interface CourseCandle extends Bar {
  /** Open time, epoch milliseconds. */
  readonly openTime: number;
}

export const COURSE_CANDLE_MS = 300_000;

/**
 * The highest ATR(5m) over its median of the 288 candles before it, among the candles that overlap
 * a trade (from the one that holds the fill to the one that holds the close): the volatility side of
 * `NEWS_SHOCK` (docs/02 sections 5 and 12). `candles` are the stored complete 5m candles in time
 * order, with enough history before the trade for the median (288 candles after the ATR warmed up);
 * the median counts candles and not clock time, so a weekend does not widen it. Null when no candle
 * of the trade has a ratio, so missing data cannot raise the cause.
 */
export function atrRatioMaxOf(
  candles: readonly CourseCandle[],
  fillAt: number,
  closedAt: number,
  window: number = BASELINE_CANDLES_24H,
): number | null {
  const atr = new Atr();
  const baseline = new MedianBaseline(window);
  let highest: number | null = null;
  let previous = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (!(candle.openTime > previous))
      throw new RangeError('candles must be in strictly rising time order');
    previous = candle.openTime;
    const value = atr.update(candle);
    if (value === null) continue;
    const normal = baseline.update(value);
    if (candle.openTime > closedAt || candle.openTime + COURSE_CANDLE_MS <= fillAt) continue;
    const ratio = ratioOf(value, normal);
    if (ratio !== null && (highest === null || ratio > highest)) highest = ratio;
  }
  return highest;
}
