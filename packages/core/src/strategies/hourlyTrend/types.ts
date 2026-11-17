import type { StrategySetup } from '../types';

/**
 * The numbers of the hourly trend strategy (a hypothesis, tuned on training data only; a change is a new strategy version). It
 * decides every `everyMin` minutes (at the close of the 5m candle that ends the slot) from the trend of the last closed 1h candle.
 */
export interface HourlyTrendParams {
  readonly periods: {
    readonly emaFast: number;
    readonly emaMid: number;
    readonly emaSlow: number;
    readonly atr: number;
  };
  /** The stop, in ATR(1h), from the close of the 5m candle. */
  readonly stopAtr1h: number;
  /** How often it decides, in minutes: a multiple of 5 that divides an hour (60 is once an hour, 30 twice). */
  readonly everyMin: number;
}

export const HOURLY_TREND_DEFAULTS: HourlyTrendParams = {
  periods: { emaFast: 20, emaMid: 50, emaSlow: 200, atr: 14 },
  stopAtr1h: 2.5,
  everyMin: 30,
};

/** The numbers behind a setup, in real prices, for the explanation. */
export interface HourlyTrendFacts {
  readonly trend: 'UP' | 'DOWN';
  /** Open time of the newest closed 1h candle, the one whose trend this is. */
  readonly hourOpen: number;
  /** The close of that candle. */
  readonly hourClose: number;
  readonly emaFast: number;
  readonly emaMid: number;
  readonly emaSlow: number;
  readonly atr1h: number;
  readonly stopAtr1h: number;
}

export type HourlyTrendSetup = StrategySetup<HourlyTrendFacts>;

/** What the strategy says on a 5m candle: a setup, or why it has none (the trend is not clear, or it is not a slot). */
export interface HourlyTrendEvaluation {
  readonly setup: HourlyTrendSetup | null;
}
