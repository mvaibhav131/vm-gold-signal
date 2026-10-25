import type { StatCandle, TickPoint } from '@vmgs/core';

import type { MarketReader } from '../news/store';

const DURATION: Readonly<Record<'1m' | '5m', number>> = { '1m': 60_000, '5m': 300_000 };

/** The stored market in memory: a test puts ticks and complete candles in. */
export class MemoryMarketReader implements MarketReader {
  tickList: TickPoint[] = [];
  readonly candles: Record<'1m' | '5m', StatCandle[]> = { '1m': [], '5m': [] };
  /** A failure that every call throws, until cleared. */
  failure: Error | null = null;

  ticks(from: number, until: number): Promise<TickPoint[]> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      this.tickList
        .filter((tick) => tick.ts >= from && tick.ts <= until)
        .sort((a, b) => a.ts - b.ts),
    );
  }

  closedCandles(tf: '1m' | '5m', until: number, limit: number): Promise<StatCandle[]> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      this.candles[tf]
        .filter((candle) => candle.openTime + DURATION[tf] <= until)
        .sort((a, b) => a.openTime - b.openTime)
        .slice(-limit),
    );
  }

  candlesBetween(tf: '1m' | '5m', from: number, until: number): Promise<StatCandle[]> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      this.candles[tf]
        .filter((candle) => candle.openTime >= from && candle.openTime < until)
        .sort((a, b) => a.openTime - b.openTime),
    );
  }
}
