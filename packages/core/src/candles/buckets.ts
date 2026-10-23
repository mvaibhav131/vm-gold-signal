import { type Timeframe, TIMEFRAME_MS } from '../domain';
import { tradingDayOf } from '../time/tradingDay';

/**
 * First instant of the candle of `tf` that contains `ms`. 1m to 4h are aligned to UTC; the 1d
 * candle is the 17:00 New York trading day.
 */
export function bucketStart(tf: Timeframe, ms: number): number {
  if (tf === '1d') return tradingDayOf(ms).startMs;
  const size = TIMEFRAME_MS[tf];
  return Math.floor(ms / size) * size;
}

/** First instant after the candle that opens at `startMs`. */
export function bucketEnd(tf: Timeframe, startMs: number): number {
  if (tf === '1d') return tradingDayOf(startMs).endMs;
  return startMs + TIMEFRAME_MS[tf];
}
