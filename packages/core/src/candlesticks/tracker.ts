import type { Timeframe } from '../domain';
import { assertCandle, assertInOrder, type StructureCandle } from '../structure/types';
import { candlesticksOf } from './detect';
import { CANDLE_DEFAULTS, type CandleParams, type CandlePattern } from './types';

/**
 * The candlestick patterns of one timeframe, candle by candle (docs/02 section 4.1). Feed it each
 * closed candle with the ATR of the same timeframe including that candle (`structure.atr` after
 * `structure.update(candle)`); it answers with the patterns that end with that candle. It only looks
 * at the last 7 candles, so incremental and batch answers are identical by construction.
 */
export class CandlestickTracker {
  private readonly recent: StructureCandle[] = [];
  private readonly keep: number;
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(
    tf: Timeframe,
    private readonly params: CandleParams = CANDLE_DEFAULTS,
    private readonly tag: string = tf,
  ) {
    this.keep = Math.max(3, params.narrowRange.lookback);
  }

  get count(): number {
    return this.seen;
  }

  update(candle: StructureCandle, atr: number | null): readonly CandlePattern[] {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    this.seen += 1;
    this.recent.push(candle);
    if (this.recent.length > this.keep) this.recent.shift();
    return candlesticksOf(this.recent, this.seen, atr, this.tag, this.params);
  }
}
