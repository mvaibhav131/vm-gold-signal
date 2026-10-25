import { bucketEnd, tradingMsBetween, type HigherTimeframe, type MarketCandle } from '@vmgs/core';

/** What the engine reads (5m, 15m, 1h) and what the charts show; the 1m candles of history are not kept. */
export const BOOTSTRAP_TIMEFRAMES: readonly HigherTimeframe[] = ['5m', '15m', '1h', '4h', '1d'];

export interface BootstrapPlan {
  readonly write: readonly MarketCandle[];
  /** Candles left out because they end after the first live minute. */
  readonly overlapsLive: number;
  /** From the end of the last history candle to the first live minute; null when there is no live data or no history before it. */
  readonly junction: {
    readonly fromMs: number;
    readonly toMs: number;
    readonly tradingHours: number;
  } | null;
}

const HOUR_MS = 3_600_000;

/**
 * The candles of the history to write: those of the timeframes above that are over before the live
 * data starts. The live recorder owns every minute it recorded, so the history never overlaps it.
 */
export function planBootstrap(
  candles: readonly MarketCandle[],
  liveFromMs: number | null,
): BootstrapPlan {
  const write: MarketCandle[] = [];
  let overlapsLive = 0;
  for (const candle of candles) {
    if (!BOOTSTRAP_TIMEFRAMES.includes(candle.tf as HigherTimeframe)) continue;
    if (liveFromMs !== null && bucketEnd(candle.tf, candle.openTime) > liveFromMs) {
      overlapsLive += 1;
      continue;
    }
    write.push(candle);
  }
  const fives = write.filter((candle) => candle.tf === '5m');
  const newest = fives.reduce<number | null>(
    (latest, candle) => Math.max(latest ?? candle.openTime, candle.openTime),
    null,
  );
  const fromMs = newest === null ? null : bucketEnd('5m', newest);
  const junction =
    fromMs === null || liveFromMs === null || liveFromMs <= fromMs
      ? null
      : { fromMs, toMs: liveFromMs, tradingHours: tradingMsBetween(fromMs, liveFromMs) / HOUR_MS };
  return { write, overlapsLive, junction };
}
