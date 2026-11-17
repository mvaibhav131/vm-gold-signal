import type { Side } from '../../domain';

/**
 * The direction of the hour: UP when the fast average of the 1h chart is above the middle one and the price is above the slow one,
 * DOWN when it is the other way round on every count, and no trend (null) when they disagree. SELL is the exact mirror of BUY.
 */
export function judgeTrend(
  close: number,
  emaFast: number,
  emaMid: number,
  emaSlow: number,
): 'UP' | 'DOWN' | null {
  if (emaFast > emaMid && close > emaSlow) return 'UP';
  if (emaFast < emaMid && close < emaSlow) return 'DOWN';
  return null;
}

/** The stop of the setup: `stopAtr1h` x ATR(1h) beyond the price, against the trade. */
export function trendStop(side: Side, price: number, atr1h: number, stopAtr1h: number): number {
  return side === 'BUY' ? price - stopAtr1h * atr1h : price + stopAtr1h * atr1h;
}
