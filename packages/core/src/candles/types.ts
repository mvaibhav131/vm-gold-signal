import type { CandleSource, Timeframe } from '../domain';

/** A normalised tick. Times are epoch milliseconds, prices have at most 3 decimals. */
export interface TickInput {
  /** Provider timestamp: the clock of the candle builder (1 s resolution). */
  readonly ts: number;
  /** When the worker received the tick. Only used to reject ticks stamped far in the future. */
  readonly rxAt: number;
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
}

/** A candle of mid prices. Same fields as the `candles` table, with the open time in epoch milliseconds. */
export interface MarketCandle {
  readonly symbol: string;
  readonly tf: Timeframe;
  readonly openTime: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly spreadAvg: number | null;
  readonly spreadMax: number | null;
  readonly tickCount: number;
  readonly complete: boolean;
  readonly source: CandleSource;
}

/** Every timeframe that is derived from closed 1m candles. */
export const HIGHER_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'] as const;
export type HigherTimeframe = (typeof HIGHER_TIMEFRAMES)[number];

export const MINUTE_MS = 60_000;
