/** How long a trade is meant to last: the name the owner sees next to a signal. */
export type TradeStyle = 'SCALP' | 'INTRADAY' | 'SWING';

export const TRADE_STYLES: readonly TradeStyle[] = ['SCALP', 'INTRADAY', 'SWING'];

/** A scalp is over within this many minutes; an intraday trade within the working day. */
export const SCALP_MAX_MIN = 45;
export const INTRADAY_MAX_MIN = 360;

/**
 * The style of a trade from the longest time it may stay open (its time stop): up to 45 minutes is a
 * scalp, up to 6 hours intraday, longer a swing. The time stop is the honest number: a trade that has not
 * worked by then is closed, so the owner never has to stay longer than this.
 */
export function tradeStyleOf(holdMinutes: number): TradeStyle {
  if (!Number.isFinite(holdMinutes) || holdMinutes < 0) {
    throw new RangeError(`a hold of ${String(holdMinutes)} minutes is not a time`);
  }
  if (holdMinutes <= SCALP_MAX_MIN) return 'SCALP';
  return holdMinutes <= INTRADAY_MAX_MIN ? 'INTRADAY' : 'SWING';
}

/** The style of a signal from its two times (epoch milliseconds). */
export const tradeStyleOfTimes = (generatedAt: number, timeStopAt: number): TradeStyle =>
  tradeStyleOf(Math.max(0, timeStopAt - generatedAt) / 60_000);
