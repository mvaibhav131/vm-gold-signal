import type { MarketCandle, TickInput } from '@vmgs/core';

import type {
  GapRecord,
  PersistedCounts,
  RecorderBatch,
  RecorderRecovery,
  RecorderStore,
} from '../store';

export class MemoryRecorderStore implements RecorderStore {
  readonly ticks: TickInput[] = [];
  readonly candles = new Map<string, MarketCandle>();
  readonly gaps = new Map<string, GapRecord>();
  readonly incidents: RecorderBatch['incidents'][number][] = [];
  readonly heartbeats: {
    workerName: string;
    at: number;
    metadata: Readonly<Record<string, unknown>>;
  }[] = [];
  partitionChecks = 0;
  recoveredOpenIncidents = 0;

  ensureTickPartitions(): Promise<number> {
    this.partitionChecks += 1;
    return Promise.resolve(0);
  }

  closeOpenIncidents(): Promise<number> {
    const closed = this.recoveredOpenIncidents;
    this.recoveredOpenIncidents = 0;
    return Promise.resolve(closed);
  }

  loadRecovery(
    _symbols: readonly string[],
    _tradedSymbol: string,
    now: number,
  ): Promise<RecorderRecovery> {
    return Promise.resolve({
      minutesBySymbol: new Map(),
      latestTicks: [],
      previousTradedTick: null,
      replayFromMs: now,
      replayUntilMs: now,
    });
  }

  *readTicks(symbol: string, from: number, until: number): Iterable<TickInput> {
    for (const tick of this.ticks) {
      if (tick.symbol === symbol && tick.ts >= from && tick.ts < until) yield tick;
    }
  }

  writeBatch(batch: RecorderBatch): Promise<PersistedCounts> {
    this.ticks.push(...batch.ticks);
    for (const candle of batch.candles) {
      this.candles.set(`${candle.symbol}|${candle.tf}|${candle.openTime}`, candle);
    }
    for (const record of batch.gaps) {
      const key = `${record.symbol}:${record.gap.startMs}:${record.gap.endMs}`;
      this.gaps.set(key, record);
    }
    this.incidents.push(...batch.incidents);
    return Promise.resolve({
      ticks: batch.ticks.length,
      candles: batch.candles.length,
      gaps: batch.gaps.length,
      incidents: batch.incidents.length,
    });
  }

  writeHeartbeat(
    workerName: string,
    at: number,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.heartbeats.push({ workerName, at, metadata });
    return Promise.resolve();
  }
}
