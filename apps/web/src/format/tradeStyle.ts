import { spanText, tradeStyleOfTimes, type TradeStyle } from '@vmgs/core';

export const STYLE_HINT: Readonly<Record<TradeStyle, string>> = {
  SCALP: 'a quick trade',
  INTRADAY: 'a trade of a few hours',
  SWING: 'a long trade, over the day',
};

export interface StyleInfo {
  readonly style: TradeStyle;
  /** The longest the trade may stay open: `2 h`. */
  readonly holdText: string;
  /** What the owner is told: `INTRADAY, up to 2 h`. */
  readonly label: string;
}

/**
 * The name of a trade and how long it may take, from the time of the signal and its time stop (the same rule as the
 * Telegram message: up to 45 minutes is a scalp, up to 6 hours intraday, longer a swing).
 */
export function styleOf(signal: { generatedAt: string; timeStopAt: string }): StyleInfo {
  const generatedAt = Date.parse(signal.generatedAt);
  const timeStopAt = Date.parse(signal.timeStopAt);
  const style = tradeStyleOfTimes(generatedAt, timeStopAt);
  const holdText = spanText(Math.max(0, timeStopAt - generatedAt));
  return { style, holdText, label: `${style}, up to ${holdText}` };
}

/** `+11.900 USD, 1.0R`: how far a target is from the entry in dollars and in times the risk. */
export function distanceNote(entry: number, level: number, riskDistance: number): string {
  const distance = Math.abs(level - entry);
  return `${distance.toFixed(3)} USD, ${(distance / riskDistance).toFixed(1)}R`;
}

/** How far the first target is from the entry, in times the risk. */
export function rewardOfTp1(signal: { entry: number; tp1: number; riskDistance: number }): number {
  return Math.abs(signal.tp1 - signal.entry) / signal.riskDistance;
}
