import type { StrategySetup } from '../types';

/** The nine questions of the vote, in the order the explanation lists them. */
export const CONFLUENCE_VOTES = [
  'TREND_1H',
  'TREND_15M',
  'EMA_STACK_5M',
  'RSI',
  'MACD',
  'ADX',
  'DAY_MEAN',
  'BREAKOUT',
  'NOT_STRETCHED',
] as const;
export type ConfluenceVote = (typeof CONFLUENCE_VOTES)[number];

/**
 * The numbers of the confluence strategy (a hypothesis, tuned on training data only; a change is a new strategy version). It
 * counts how many of nine independent readings agree with a direction on the close of a 5m candle, and speaks when enough do
 * and the candle itself pushes that way.
 */
export interface ConfluenceParams {
  readonly periods: {
    readonly emaFast: number;
    readonly emaMid: number;
    readonly emaSlow: number;
    readonly rsi: number;
    readonly atr: number;
    readonly adx: number;
  };
  /** How many of the nine votes must agree (the most is 9). */
  readonly minVotes: number;
  /** The trigger candle's body must be at least this many ATR(5m), and push the way of the trade. */
  readonly minBodyAtr: number;
  /** ATR(5m) must be at least this share of its average of the last day: a dead market has no room for the target. */
  readonly atrFloor: number;
  /** The stop goes beyond the lowest low (highest high for a SELL) of this many 5m candles, the newest included. */
  readonly swingCandles: number;
  /** ... plus this many ATR(5m), so that it is not at the level where stops are collected. */
  readonly stopBufferAtr: number;
  /** The stop is never closer than this, and a setup whose structure puts the stop further than the largest is skipped. */
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  /** A stop wider than this many dollars is skipped: the first target is as far as the stop. */
  readonly maxStopUsd: number;
  /** At most one setup for each side in a slot of this many minutes (a multiple of 5 that divides a day). */
  readonly slotMin: number;
  /** The session in which it speaks, in minutes of the UTC day: from (included) to (excluded). */
  readonly sessionFromMin: number;
  readonly sessionToMin: number;
}

export const CONFLUENCE_DEFAULTS: ConfluenceParams = {
  periods: { emaFast: 20, emaMid: 50, emaSlow: 200, rsi: 14, atr: 14, adx: 14 },
  minVotes: 7,
  minBodyAtr: 0.4,
  atrFloor: 0.8,
  swingCandles: 10,
  stopBufferAtr: 0.5,
  minStopAtr: 3,
  maxStopAtr: 4.2,
  maxStopUsd: 16,
  slotMin: 30,
  sessionFromMin: 7 * 60,
  sessionToMin: 20 * 60 + 30,
};

/** The numbers behind a setup, in real prices, for the explanation. */
export interface ConfluenceFacts {
  readonly trend1h: 'UP' | 'DOWN' | null;
  readonly trend15m: 'UP' | 'DOWN' | null;
  /** The votes that agreed with the side, in `CONFLUENCE_VOTES` order. */
  readonly votes: readonly ConfluenceVote[];
  readonly rsi: number;
  readonly macdHistogram: number;
  readonly adx: number;
  readonly plusDI: number;
  readonly minusDI: number;
  readonly atr5m: number;
  /** ATR(5m) over its average of the last day. */
  readonly atrRatio: number;
  readonly emaFast5m: number;
  readonly emaMid5m: number;
  readonly dayMean: number;
  /** The level the stop was built from (the swing low of a BUY, the swing high of a SELL). */
  readonly swingLevel: number;
  /** The distance from the close to the stop, in ATR(5m), after the minimum. */
  readonly stopAtr: number;
  readonly stopUsd: number;
}

export type ConfluenceSetup = StrategySetup<ConfluenceFacts>;

/** What the strategy says on a 5m candle: a setup, or nothing. */
export interface ConfluenceEvaluation {
  readonly setup: ConfluenceSetup | null;
}
