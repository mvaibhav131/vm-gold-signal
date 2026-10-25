import { TIMEFRAME_MS } from '../domain';
import { ENGINE_TIMEFRAMES, type EngineCandle, type EngineTimeframe } from './types';

/** A closed candle with its timeframe and the instant it closed. */
export interface FeedStep {
  readonly tf: EngineTimeframe;
  readonly candle: EngineCandle;
  /** `openTime` plus the length of the timeframe. */
  readonly closeTime: number;
}

/** The order in which candles that close at the same instant are fed: the higher timeframes first, so the 5m decision sees everything that closed with it. */
const TIE_ORDER: Readonly<Record<EngineTimeframe, number>> = { '1h': 0, '15m': 1, '5m': 2 };

/**
 * One list of closed candles of the three timeframes, in the order they closed (the 1h and 15m
 * candle that close with a 5m candle first). It is the order in which the live worker, the
 * warm-up and the backtester feed `DecisionEngine.push`, so all three see the same market.
 */
export function mergeByClose(
  series: Readonly<Record<EngineTimeframe, readonly EngineCandle[]>>,
): FeedStep[] {
  const steps: FeedStep[] = [];
  for (const tf of ENGINE_TIMEFRAMES) {
    for (const candle of series[tf]) {
      steps.push({ tf, candle, closeTime: candle.openTime + TIMEFRAME_MS[tf] });
    }
  }
  return steps.sort((a, b) => a.closeTime - b.closeTime || TIE_ORDER[a.tf] - TIE_ORDER[b.tf]);
}
